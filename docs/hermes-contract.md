# Hermes contract

Two directions: the **worker triggers Hermes** (outbound) and **Hermes reports
milestones** to the API webhook (inbound). All bodies are JSON (UTF-8).

Multi-row dashboard imports use `vehicle.batch_ready`. A mixed-store transport
upload is split into one execution batch per store. Each payload contains the
shared store/schedule plus an ordered `vehicles` array. Every child has its own
`request_id`, freight evidence, and corrections. Hermes keeps one AutoSoft
session, processes children sequentially, and sends the normal callback twice
per child (`PROCESSING`, then `COMPLETED` or `FAILED`).

## 1. Trigger (worker → Hermes)

`POST {HERMES_ENDPOINT}` to Hermes's native webhook route. The raw JSON body
is signed with `HERMES_TRIGGER_SECRET`:

On Orgo, `HERMES_ENDPOINT` is the authenticated computer `/bash` route
and `HERMES_LOCAL_WEBHOOK_URL` is the loopback Hermes route. The worker wraps
the signed event in one base64-safe PowerShell forwarding command because Orgo
does not expose arbitrary guest ports. Without that bridge, the worker sends
the same signed body directly to `HERMES_ENDPOINT`.

| Header | Value |
| --- | --- |
| `X-Webhook-Timestamp` | current Unix timestamp in seconds |
| `X-Webhook-Signature-V2` | hex HMAC-SHA256 of `<timestamp>.<raw body>` |
| `X-Request-ID` | the payload `request_id` (Hermes idempotency key) |
| `Authorization` | optional `Bearer HERMES_PROXY_TOKEN` for the Orgo computer API transport |

```json
{
  "event_type": "vehicle.ready",
  "request_id": "cmb123abc:0",
  "callback_url": "https://api.example.com/api/webhooks/hermes",
  "store": {
    "code": "LA_CITY",
    "name": "LA City",
    "autosoft_instance": "LA City Cars",
    "stock_prefix": "L",
    "internal_charges": [
      { "label": "Pack", "amount": 1761 },
      { "label": "LoJack", "amount": 134 },
      { "label": "CSC3MPro", "amount": 55 },
      { "label": "Cilajet", "amount": 54 }
    ],
    "charges_total": 2004
  },
  "vehicle": {
    "vin": "1HGCM82633A004352",
    "model": "2022 Honda Accord EX-L",
    "stock_number": null
  },
  "schedule": {
    "starts_at": "2026-08-20T23:00:00.000Z",
    "eastern": "Aug 20, 2026, 7:00 PM EDT",
    "pacific": "Aug 20, 2026, 4:00 PM PDT"
  },
  "freight": {
    "amount": 300,
    "evidence": {
      "loadId": "123456789012",
      "loadPrice": 900,
      "distinctVinCount": 3,
      "vins": ["..."],
      "matchedRowNumbers": [12],
      "loadRowNumbers": [12, 13, 14],
      "source": "https://.../dispatch.xlsx",
      "fetchedAt": "2026-08-19T18:00:00.000Z"
    }
  },
  "corrections": [
    { "note": "Model year was wrong; corrected to 2022", "fields": { "model": "2022 Honda Accord EX-L" }, "created_at": "..." }
  ]
}
```

- `request_id` = `<vehicleId>:<dispatchNonce>` — unique per dispatch cycle.
  **Echo it back** in callbacks so the API can match the exact vehicle.
- The trigger is idempotent on our side: a vehicle is claimed atomically before
  the request is sent and can never be triggered twice concurrently. Hermes
  should also treat a repeated `request_id` as the same run.
- Hermes responds `202` after accepting the independent agent run. Any non-2xx / timeout is retried by the worker
  (5 attempts, exponential backoff), then the vehicle is marked `FAILED`.
- The worker permits one active desktop run. Later READY vehicles remain
  delayed while another vehicle is `PROCESSING`.
- A batch also holds the global desktop lock from trigger acceptance until all
  claimed child callbacks are terminal. Completed children are permanent
  checkpoints; a later continuation includes only newly READY, unclaimed VINs.
  A watchdog fails every non-terminal claimed child closed if the batch stops
  reporting, because partial live-system work cannot be assumed safe to retry.
- `schedule.starts_at` is the authoritative UTC not-before boundary. The worker
  creates a delayed job and rechecks the boundary immediately before dispatch;
  Hermes independently checks it before touching any live system. Eastern and
  Pacific labels are DST-aware operator displays. Scheduling never permits two
  concurrent sessions on the shared AutoSoft account.
- The dedicated `vehicle-stocking` route is loopback-only and HMAC-authenticated.
  It explicitly enables only the terminal, file, browser, computer-use, vision,
  skills, task, and memory toolsets required by the stocking playbook. Generic
  webhook routes remain restricted.
- A watchdog marks a job `FAILED` if Hermes supplies no terminal callback within
  90 minutes (configurable). This fail-closed recovery prevents an abandoned
  `PROCESSING` row from blocking every later vehicle; an operator must verify
  the live systems before using the audited retry action.

## 2. Callback (Hermes → API)

`POST {callback_url}` (`/api/webhooks/hermes`) with headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Hermes-Signature` | `sha256=<hex HMAC-SHA256(raw request body, HERMES_WEBHOOK_SECRET)>` |
| `X-Hermes-Delivery` | unique delivery ID (retries reuse the same ID) — recommended |

Body:

```json
{
  "request_id": "cmb123abc:0",
  "vin": "1HGCM82633A004352",
  "status": "COMPLETED",
  "stock_number": "L12345",
  "freight_amount": 300,
  "final_total": 2304,
  "acv": 21500,
  "rag_commit_id": "rag-2026-08-19-0042",
  "failure_reason": null,
  "run_summary": "Stocked L12345 in AutoSoft; posted internal charges 2004; ...",
  "evidence": { "screens": ["..."], "steps": 14 }
}
```

- `status` ∈ `PROCESSING | COMPLETED | FAILED`. Send `PROCESSING` when the run
  starts, then a terminal `COMPLETED`/`FAILED`. `FAILED` should carry
  `failure_reason`.
- Only `vin` and `status` are required; send everything you have. `acv`,
  `final_total`, `stock_number`, and `rag_commit_id` populate the Completed Ledger.

### Signature example (Python)

```python
import hashlib, hmac, json, requests

body = json.dumps(payload, separators=(",", ":")).encode()
sig = "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
requests.post(callback_url, data=body, headers={
    "Content-Type": "application/json",
    "X-Hermes-Signature": sig,
    "X-Hermes-Delivery": delivery_id,
})
```

### API responses

| Status | Meaning |
| --- | --- |
| `200 {"status":"applied", ...}` | callback applied; state advanced |
| `200 {"status":"duplicate"}` | same delivery seen before (idempotent no-op) |
| `200 {"status":"already_in_state"}` | vehicle already in that state (no-op) |
| `401 INVALID_SIGNATURE` | bad/missing HMAC — check the secret and raw-body signing |
| `400` | invalid JSON or schema |
| `404 VEHICLE_NOT_FOUND` | no vehicle for the request_id/VIN |
| `409 INVALID_TRANSITION` | e.g. `PROCESSING` after `COMPLETED` |

Every callback — valid or not — is stored immutably (`WebhookEvent`) for audit,
including the RAG commit reference. Retries are safe: send the same delivery ID
and the API will no-op.
