# Runbook

## Daily signals

- **Command Center → Action Required lane.** Anything here needs a human:
  read the failure reason on the card, open the vehicle, fix the underlying
  data (correction fields), and use **Retry** (a note is mandatory and becomes
  part of the Hermes context).
- **`/ready` endpoint** (api) — Railway health checks alert if DB/Redis drop.

## Common situations

### Vehicle stuck in AWAITING_FREIGHT
The VIN is not on the dispatch workbook (or its rows are cancelled, its load has
no/conflicting prices — the timeline event names the exact reason). The system
retries automatically with backoff and will surface `ACTION_REQUIRED` after 20
checks. Fix the workbook (or the VIN, via intake correction + retry); the next
check picks it up. **The system never estimates freight** — do not look for an
override; there deliberately isn't one.

### Workbook unreachable / unparseable
Timeline shows `FREIGHT_CHECK_ERROR`; checks reschedule every 5 minutes without
consuming attempts. Verify `DISPATCH_WORKBOOK_URL`/`_PATH` and that the file has
VIN / Load ID / Load Price headers (names, not letters, are matched).

### Hermes unreachable
Dispatch retries 5× with exponential backoff, then the vehicle goes `FAILED`
with reason "Hermes unreachable". Check the Orgo computer and `HERMES_ENDPOINT`,
then Retry from the vehicle page (freight is preserved; it re-dispatches
immediately).

### Webhook signature failures (401 in API logs)
`HERMES_WEBHOOK_SECRET` mismatch or Hermes isn't signing the *raw* callback body.
Every attempt is stored in `WebhookEvent` with `signatureValid=false` for audit.

### Duplicate intake
Intake is idempotent per active Store+VIN — resubmitting returns the existing
record and creates nothing. A VIN can be re-stocked only after the previous
record completes.

## Secret rotation

All secrets are environment variables — **no secret ever lives in this repo**,
and Railway tokens belong only in Railway/CI secret stores.

| Secret | Rotate by | Effect |
| --- | --- | --- |
| `OPERATOR_PASSWORD` | set new value on api service, redeploy | operator logs in with the new password |
| `SESSION_SECRET` | set new value, redeploy api | all sessions invalidated; operator re-logs in |
| `HERMES_WEBHOOK_SECRET` | update on the Hermes agent **and** api together | callbacks signed with the old secret are rejected (401) |
| `HERMES_TRIGGER_SECRET` | update on the Hermes webhook route **and** worker together | triggers with the old secret are rejected by Hermes |
| `HERMES_PROXY_TOKEN` | update on the worker when the Orgo server token rotates | Orgo rejects the transport request before it reaches Hermes |
| `DATABASE_URL` / `REDIS_URL` | rotate credentials in Railway; references update automatically | redeploy all three services |

Rotation order for the paired secrets: configure the receiver to accept the new
value first (Hermes for the trigger secret, api for the webhook secret), then update the
sender, then remove the old value.

## Data audit

- `VehicleEvent` — append-only timeline per vehicle (state changes, freight
  evidence, Hermes triggers/callbacks, corrections, retries).
- `WebhookEvent` — every callback ever received, with dedupe key, signature
  validity, and reject reason. Never mutated after processing flags are set.
- Completed Ledger → **Export CSV** for accounting (Excel-ready).
