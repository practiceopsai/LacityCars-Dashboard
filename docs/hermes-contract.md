# Hermes contract

Two directions: the **worker triggers Hermes** (outbound) and **Hermes reports
milestones** to the API webhook (inbound). All bodies are JSON (UTF-8).

## 1. Trigger (worker → Hermes)

`POST {HERMES_ENDPOINT}` with `Authorization: Bearer {HERMES_API_TOKEN}`.

```json
{
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
- Respond `2xx` to acknowledge. Any non-2xx / timeout is retried by the worker
  (5 attempts, exponential backoff), then the vehicle is marked `FAILED`.

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
