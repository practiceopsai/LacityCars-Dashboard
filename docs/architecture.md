# Architecture

## Services

### apps/web — dashboard (Next.js 15, App Router)

- All browser traffic goes to the web origin. `next.config.mjs` rewrites
  `/api/:path*` to the API service (`API_URL`), so the session cookie is
  first-party, SameSite applies, and the browser never needs CORS.
- `src/middleware.ts` redirects to `/login` when the session cookie is absent
  (UX only — the API cryptographically verifies every request).
- Views: Command Center (Kanban, SSE live updates with polling fallback),
  Intake (single + bulk CSV with preview/per-row errors), Completed Ledger
  (filterable, paginated, CSV export), Vehicle detail (timeline, freight
  evidence, corrections, guarded retry), Store Settings.
- Plain CSS design system (`globals.css`) with CSS variables; no UI framework.

### apps/api — Express

Route map:

| Route | Notes |
| --- | --- |
| `POST /api/auth/login`, `/logout`, `GET /me` | constant-time password check → HMAC session cookie |
| `POST /api/vehicles/intake` | single or batch; strict VIN; idempotent per active Store+VIN |
| `POST /api/batches/intake`, `GET /api/batches` | split a transport upload by store; track execution/checkpoint status |
| `POST /api/batches/:id/retry` | audited future-scheduled retry of non-completed children after live-state verification |
| `GET /api/vehicles` | pagination + store/status/search filters |
| `GET /api/vehicles/stream` | SSE, 15 s heartbeats, fed by Redis pub/sub |
| `GET /api/vehicles/export.csv` | Excel-friendly (BOM, CRLF) ledger export |
| `GET /api/vehicles/:id` | detail + timeline + corrections |
| `POST /api/vehicles/:id/retry` | note required; requeues eligible vehicles |
| `POST /api/vehicles/:id/corrections` | stored; included in next Hermes trigger |
| `GET/POST/PUT /api/stores` | registry CRUD; charges must sum to declared total |
| `POST /api/webhooks/hermes` | HMAC-authenticated, idempotent, transition-enforced |
| `GET /health`, `GET /ready` | liveness / readiness (DB + Redis ping) |

Cross-cutting: request IDs on every response, structured error envelope
(`{error: {code, message, details?, requestId}}`), Redis fixed-window rate
limits (login 10/min, mutations 60/min, webhook 120/min — fail-open with a log
line if Redis is down), Helmet, CORS restricted to `WEB_ORIGIN`, 1 MB body
limits, pino with secret redaction.

### apps/worker — BullMQ

- **freight-check queue.** Loads a *fresh* workbook every run
  (`DISPATCH_WORKBOOK_URL` or `_PATH`), parses it (`@lacity/freight`), computes
  freight. Found → `READY` + enqueue Hermes dispatch. Miss → `AWAITING_FREIGHT`
  with exponential backoff (base 5 min, doubling, cap 6 h) until
  `FREIGHT_MAX_ATTEMPTS` (20) → `ACTION_REQUIRED`. Workbook/infra errors do not
  consume attempts; they reschedule in 5 min and leave a timeline event.
- **hermes-dispatch queue.** Claims the vehicle with a conditional update
  (`status=READY AND hermesDispatchedAt IS NULL`) *before* any network call —
  this is the idempotency/concurrency guard; BullMQ job IDs
  (`hermes:<vehicleId>:<nonce>`) additionally dedupe queue entries. On send
  failure the claim is released only if the vehicle is still `READY`, and BullMQ
  retries (5 attempts, exponential); the final failure marks the vehicle
  `FAILED` with a reason.
- **store-batch dispatch.** Multi-row uploads share a transport `groupKey` and
  are split into one `StockingBatch` per store. The worker claims all READY
  children in input order and sends one Hermes run, which updates the sheet in
  one pass and retains one AutoSoft session. Each VIN keeps its own request ID,
  state transition, callback, RAG checkpoint, and failure result. Missing
  freight is excluded rather than estimated and can enter a later continuation.

## Data model (Prisma)

- `Store` — code, name, aliases[], stockPrefix, autosoftInstance,
  internalCharges (JSON `[{label, amount}]`), chargesTotal. **No credentials.**
- `Vehicle` — normalized VIN, model, status enum, freight amount/evidence (JSON),
  ACV/final total/RAG commit from Hermes, freight attempt counters,
  `hermesDispatchedAt` + `dispatchNonce` + unique `hermesRequestId` for dispatch
  idempotency.
- `VehicleEvent` — append-only timeline (never updated/deleted).
- `WebhookEvent` — immutable record of every callback (valid or not), unique
  `dedupeKey` (delivery header or body hash) enforcing webhook idempotency.
- `Correction` — operator notes/fields; included in Hermes trigger context.

Intake idempotency (one active record per Store+VIN) is enforced by lookup
against active statuses before create; duplicates return the existing record.

## Real-time flow

Any vehicle change (API or worker) publishes `{vehicleId, vin, status,
storeCode, updatedAt}` on the Redis channel `lacity:vehicle-updates`. Each API
instance has one subscriber fanning out to its SSE clients. The dashboard
debounces SSE bursts into refetches and falls back to 20 s polling whenever the
stream is not live.

## State machine

Defined once in `packages/shared/src/status.ts` and enforced by
`transitionVehicle()` (`packages/database/src/transitions.ts`), used by both API
and worker inside a transaction that also writes the timeline event.
`PROCESSING → PROCESSING` is idempotent; `READY → COMPLETED` covers out-of-order
callbacks; `COMPLETED` is terminal.

## Adding a store

Store Settings → *Add store* (or `POST /api/stores`). Provide code, name,
aliases, stock prefix, AutoSoft instance, and the internal-charge schedule; the
API rejects saves where charges don't sum to the declared total. Nothing else to
deploy — intake, freight, Hermes payloads, and the UI all read the registry.
