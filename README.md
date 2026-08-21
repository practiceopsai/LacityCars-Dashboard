# LacityCars-Dashboard

Dealership stocking command center. An operator submits **Store + VIN + Model**;
the system verifies per-car freight against the live dispatch workbook, triggers
the headless **Hermes** agent (running on an Orgo Windows computer) to complete
AutoSoft stocking/accounting, tracks every milestone in real time, and keeps an
immutable, exportable ledger of completed vehicles.

## Repo ownership

- **Owner/operator:** LacityCars dealership operations (single-operator dashboard).
- **Stores today:** LA City (stock prefix `L`) and Columbia City (stock prefix `S`).
  New stores are added through **Store Settings** — the system is configuration-driven,
  no code change required.

## Architecture

```
Browser ── same-origin ──► apps/web (Next.js) ── /api/* rewrite ──► apps/api (Express)
                                                                     │  ▲
                                              BullMQ (Redis) ◄───────┘  │ webhook (HMAC)
                                                    │                   │
                                              apps/worker ── trigger ──► Hermes agent (Orgo)
                                                    │
                                     dispatch workbook (URL or file)
                    PostgreSQL (Prisma) ◄── api + worker    Redis pub/sub ──► SSE to dashboard
```

| Piece | Purpose |
| --- | --- |
| `apps/web` | Next.js App Router dashboard (Command Center Kanban, Intake, Ledger, Store Settings, vehicle detail). Proxies `/api/*` to the API so cookies stay same-origin. |
| `apps/api` | Express API: intake, listing/detail, retry/corrections, store registry, SSE stream, Hermes webhook, health/readiness. |
| `apps/worker` | BullMQ workers: freight verification against a fresh dispatch workbook + idempotent Hermes dispatch. |
| `packages/database` | Prisma schema/client, deterministic seed, shared state-transition helper. |
| `packages/freight` | Standalone dispatch-workbook parser + freight calculator (fully unit-tested). |
| `packages/shared` | Zod contracts, VIN validation, state machine, store rules, constants. |

See [docs/architecture.md](docs/architecture.md) for details and
[docs/hermes-contract.md](docs/hermes-contract.md) for the Hermes trigger/webhook contract.

## Status model

`PENDING → AWAITING_FREIGHT → READY → PROCESSING → COMPLETED` with
`ACTION_REQUIRED` (operator input needed, e.g. freight never appeared) and
`FAILED` (Hermes run failed) as recoverable branches. `COMPLETED` is terminal.
Transitions are enforced centrally (`packages/shared/src/status.ts`); invalid
webhook transitions are rejected with `409` and recorded.

**Freight rule:** exact normalized 17-char VIN match in the *fresh* workbook;
per-car freight = whole load price ÷ distinct active VINs on that normalized load.
Columns are resolved by header name (never fixed letters), cancelled/void/declined
rows are excluded, scientific-notation load IDs are normalized. If the VIN is not
on the workbook the vehicle sits in `AWAITING_FREIGHT` and retries on exponential
backoff (5 min doubling, capped at 6 h, max 20 attempts → `ACTION_REQUIRED`).
**Freight is never estimated.**

**Retry behavior:** operators can requeue `ACTION_REQUIRED`, `FAILED`, or
`AWAITING_FREIGHT` vehicles from the vehicle page. A correction/note is required;
it is stored and included in the next Hermes trigger payload. Vehicles with
verified freight go straight back to `READY` (re-dispatch); others restart
freight verification.

**RAG feedback loop:** every Hermes callback carries `rag_commit_id` and
`run_summary`. Both are stored immutably (`WebhookEvent` + timeline event) and
surfaced on the vehicle page and the Completed Ledger, so each run's knowledge-base
commit is auditable end to end.

## Local setup

Prereqs: Node ≥ 20.19 (22 recommended), pnpm 9 (`corepack enable`), Docker.

```bash
pnpm install
docker compose up -d               # local Postgres + Redis
cp .env.example .env               # fill in values (see below)
pnpm db:push                       # create schema
pnpm db:seed                       # seed LA City + Columbia City
pnpm build                         # build all packages/apps

# three terminals (each loads .env — use dotenv-cli, direnv, or exported vars):
pnpm dev:api
pnpm dev:worker
pnpm dev:web                       # http://localhost:3000
```

Quality gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
(also run by GitHub Actions CI).

## Environment variables

Names live in [.env.example](.env.example) — values never belong in the repo.

| Service | Variables |
| --- | --- |
| api | `DATABASE_URL`, `REDIS_URL`, `API_PORT`, `WEB_ORIGIN`, `SESSION_SECRET`, `OPERATOR_PASSWORD`, `HERMES_WEBHOOK_SECRET` |
| worker | `DATABASE_URL`, `REDIS_URL`, `HERMES_ENDPOINT`, optional `HERMES_LOCAL_WEBHOOK_URL`, `HERMES_TRIGGER_SECRET`, optional `HERMES_PROXY_TOKEN`, `PUBLIC_API_URL`, `DISPATCH_WORKBOOK_URL` *or* `DISPATCH_WORKBOOK_PATH`, optional `FREIGHT_SWEEP_CRON` (default `0 8,20 * * *`) and `FREIGHT_SWEEP_TIME_ZONE` (default `America/New_York`) |
| web | `API_URL` (internal URL of the API; used by the `/api/*` rewrite, needed at build time) |

## Railway deployment

Three services from this one repo (plus managed Postgres and Redis). Each app has
a `Dockerfile` and a `railway.json`. Step-by-step: [docs/railway.md](docs/railway.md).

Summary: create Postgres + Redis, then three services pointing at
`apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/web/Dockerfile` (build
context = repo root). Wire `DATABASE_URL`/`REDIS_URL` references, set the
secrets above in each service's variables, give api + web public domains, set
web's `API_URL` to the api's URL, and run `pnpm db:push && pnpm db:seed` once
against the Railway database.

> **Railway tokens and other credentials never belong in this repo** — not in
> code, not in `.env.example`, not in CI files. Use Railway service variables
> and GitHub Actions secrets.

## Hermes / Orgo webhook setup

1. Enable Hermes's native `vehicle-stocking` webhook route with the same
   `HERMES_TRIGGER_SECRET` used by the worker. The worker sends timestamp-bound
   HMAC-v2 signatures. For the Orgo computer API transport, set its server-only bearer token as
   `HERMES_PROXY_TOKEN`.
2. Configure Hermes to sign every callback body with `HERMES_WEBHOOK_SECRET`
   (`X-Hermes-Signature: sha256=<hex hmac-sha256(raw body)>`) and POST it to
   `https://<api-domain>/api/webhooks/hermes`. Include a stable
   `X-Hermes-Delivery` ID per delivery for exact idempotency.
3. Full payload schema and examples: [docs/hermes-contract.md](docs/hermes-contract.md).

## Security notes

- Single-operator session: `OPERATOR_PASSWORD` login → HMAC-signed httpOnly
  `SameSite=Lax` cookie. No secrets ever reach browser JS.
- Mutations require the `X-Requested-With: fetch` header (CSRF defense-in-depth
  on top of SameSite cookies); webhook and mutation routes are rate-limited in Redis.
- Helmet, strict CORS, 1 MB body limits, Zod validation everywhere, pino logging
  with credential redaction.
- The database stores **no accounting PINs or operational credentials** — store
  config is aliases/prefixes/charges only.
- Secret rotation runbook: [docs/runbook.md](docs/runbook.md).

## Runbook

Operational procedures (stuck vehicles, workbook problems, Hermes outages,
secret rotation): [docs/runbook.md](docs/runbook.md).
