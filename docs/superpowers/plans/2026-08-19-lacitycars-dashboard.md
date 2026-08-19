# LacityCars-Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution chosen — session is autonomous). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-ready pnpm TypeScript monorepo: dealership stocking dashboard (Next.js), Express API + SSE, BullMQ worker for freight verification + Hermes dispatch, Prisma/PostgreSQL, Redis.

**Architecture:** Browser talks only to the Next.js origin; `/api/*` is rewritten (proxied) to the Express API so the httpOnly session cookie is same-origin and SameSite CSRF protection applies. The API persists vehicles and enqueues BullMQ jobs; the worker parses the dispatch workbook, computes freight, and triggers Hermes; Hermes reports back via authenticated webhook. Redis pub/sub fans vehicle updates out to the API's SSE endpoint.

**Tech Stack:** pnpm workspaces, TypeScript 5.8, Next.js 15 (App Router, React 19), Express 4, BullMQ 5 + ioredis, Prisma 6 + PostgreSQL, Zod 3, ExcelJS, Vitest 3, ESLint 9 flat config, pino.

**Spec:** Provided verbatim in the session prompt (user message dated 2026-08-19). This plan argues from that spec.

## Global Constraints

- Canonical states: `PENDING, AWAITING_FREIGHT, READY, PROCESSING, ACTION_REQUIRED, COMPLETED, FAILED`.
- Freight: exact normalized 17-char VIN match; per-car = whole load price / distinct active VINs on normalized load; headers resolved by name; cancelled/void/declined rows excluded; scientific-notation load IDs normalized; absent ⇒ AWAITING_FREIGHT + BullMQ backoff; **never estimate freight**.
- Hermes trigger idempotent, never concurrent per vehicle; auth via `HERMES_API_TOKEN`. Webhook auth via `HERMES_WEBHOOK_SECRET` HMAC, constant-time compare, state-transition + idempotency enforcement, immutable event storage.
- Stores seeded: LA City (aliases LA, LA City Cars; prefix L; AutoSoft "LA City Cars") and Columbia City (aliases Columbia, Columbia City Cars; prefix S; AutoSoft "Columbia City Cars LLC"); both charges Pack 1761 + LoJack 134 + CSC3MPro 55 + Cilajet 54 = 2004. No accounting PINs/credentials in DB.
- No secrets in source; `.env.example` names + safe values only. Typecheck, lint, tests, prod builds must pass; commit only then.
- Node >= 20.19 (Node 22 compatible). No mock secrets, no TODO-only endpoints, no silent freight fallback.

---

## File Structure

```
package.json / pnpm-workspace.yaml / tsconfig.base.json / eslint.config.mjs
.env.example / docker-compose.yml / .gitignore / README.md
.github/workflows/ci.yml
docs/architecture.md  docs/hermes-contract.md  docs/railway.md  docs/runbook.md
packages/shared/    src/{vin,status,stores,contracts,constants}.ts + tests
packages/freight/   src/{normalize,parse,calculate}.ts + tests (ExcelJS parser kept separate from pure calculator)
packages/database/  prisma/schema.prisma  src/{index,seed}.ts
apps/api/    src/{index,app,config,logger}.ts  src/middleware/{auth,csrf,rateLimit,requestId,error}.ts
             src/routes/{auth,vehicles,stores,webhooks,health,stream}.ts
             src/services/{vehicleService,publish,queues,webhookAuth,session}.ts + tests
apps/worker/ src/{index,config,logger,workbookSource,hermesClient}.ts src/processors/{freightCheck,hermesDispatch}.ts
apps/web/    next.config.mjs  src/middleware.ts  src/app/{layout,page,login,intake,ledger,stores,vehicles/[id]}
             src/components/*  src/lib/{api,sse,csv,format}.ts  src/app/globals.css
apps/{api,worker,web}/Dockerfile  + railway.json per app
```

## Key Contracts (produced once in `@lacity/shared`, consumed everywhere)

- `normalizeVin(raw): string` (trim, uppercase, strip spaces/dashes); `validateVin(raw): {ok, vin?, errors[]}` — 17 chars, `[A-HJ-NPR-Z0-9]`, ISO 3779 check digit at position 9.
- `VehicleStatus` enum + `ALLOWED_TRANSITIONS: Record<VehicleStatus, VehicleStatus[]>` + `canTransition(from,to)`:
  - PENDING → AWAITING_FREIGHT, READY, ACTION_REQUIRED, FAILED
  - AWAITING_FREIGHT → AWAITING_FREIGHT, READY, ACTION_REQUIRED, FAILED
  - READY → PROCESSING, COMPLETED, ACTION_REQUIRED, FAILED (COMPLETED allowed for out-of-order callbacks)
  - PROCESSING → PROCESSING, COMPLETED, ACTION_REQUIRED, FAILED
  - ACTION_REQUIRED → AWAITING_FREIGHT, READY, FAILED; FAILED → AWAITING_FREIGHT, READY; COMPLETED → (terminal)
  - Semantics: Hermes-callback FAILED ⇒ status FAILED (agent run failed); freight retries exhausted / operator-input-needed ⇒ ACTION_REQUIRED. Retry-eligible: ACTION_REQUIRED, FAILED, AWAITING_FREIGHT.
- `validateStoreCharges(charges: {label,amount}[], total): {ok, computedTotal}` — reject mismatch.
- Zod: `IntakeRequest` (single or array of {store, vin, model}), `HermesCallback` ({request_id?, vin, status: PROCESSING|COMPLETED|FAILED, stock_number?, freight_amount?, final_total?, acv?, rag_commit_id?, failure_reason?, run_summary?, evidence?}), `HermesTriggerPayload`, `StoreUpsert`, `RetryRequest` ({note, corrections?}).

`@lacity/freight`:
- `parseDispatchWorkbook(buffer): DispatchRow[]` — header row resolved by name aliases (vin / load id / load price / status), returns `{vin, loadId, loadPrice, status, rowNumber}` raw strings.
- `normalizeLoadId(value)` — handles `1.234567890123E+12` sci-notation, trailing `.0`, whitespace, case.
- `calculateFreight(rows, vin): FreightResult` — `{found:true, amount, evidence:{loadId, loadPrice, distinctVinCount, vins, matchedRows}} | {found:false, reason: 'VIN_NOT_FOUND'|'NO_ACTIVE_LOAD'|'NO_LOAD_PRICE'|'AMBIGUOUS_LOAD_PRICE'}` — cents-precision rounding, never estimates.

Queues: `freight-check` (jobId `freight:{vehicleId}:{attempt}`; backoff 5m→10m→20m…cap 6h, max 20 attempts ⇒ ACTION_REQUIRED) and `hermes-dispatch` (jobId `hermes:{vehicleId}:{dispatchNonce}`; DB conditional-update guard `status=READY AND hermesDispatchedAt IS NULL` prevents concurrent double-trigger).

Webhook auth: `X-Hermes-Signature: sha256=<hex HMAC-SHA256(rawBody, HERMES_WEBHOOK_SECRET)>`, `crypto.timingSafeEqual`; idempotency via unique dedupe key (`X-Hermes-Delivery` or body hash) on immutable `WebhookEvent` row.

Session: `POST /api/auth/login {password}` compares sha256(password) to sha256(OPERATOR_PASSWORD) via timingSafeEqual; sets httpOnly SameSite=Lax cookie `lacity_session` = `v1.<exp>.<HMAC(exp, SESSION_SECRET)>`. Mutations additionally require `X-Requested-With: fetch` header. Rate limiting: Redis fixed window (login 10/min/IP, mutations 60/min, webhook 120/min).

## Tasks

### Task 1: Repo scaffolding
- [ ] Root package.json (scripts: build/typecheck/lint/test fan-out), pnpm-workspace.yaml, tsconfig.base.json, eslint.config.mjs, .gitignore, .env.example, docker-compose.yml (postgres:16, redis:7).

### Task 2: `@lacity/shared` (TDD)
- [ ] Write vin.test.ts (valid VIN `1HGCM82633A004352`, bad length, I/O/Q, bad check digit, normalization), status.test.ts (every allowed/denied edge incl. terminal COMPLETED), stores.test.ts (2004 total passes, mismatch fails). Implement to green.

### Task 3: `@lacity/freight` (TDD)
- [ ] Tests: duplicate VIN rows on one load count once; cancelled/void/declined rows excluded from match and from distinct count; sci-notation load IDs group with plain equivalents; missing VIN ⇒ found:false; ambiguous conflicting load prices ⇒ found:false AMBIGUOUS; header-name resolution with alias/ordering variations; ExcelJS round-trip parse test. Implement to green.

### Task 4: `@lacity/database`
- [ ] schema.prisma (Store, Vehicle, VehicleEvent, WebhookEvent, Correction; enums; indexes; `@@index([storeId, vin])`), client singleton export, deterministic seed (upsert by store code), scripts `db:push`, `db:seed`.

### Task 5: `apps/api`
- [ ] Config (zod-validated env), pino logger with redaction, requestId middleware, structured error handler, session service + auth middleware, CSRF header check, Redis rate limiter, webhookAuth (pure, unit-tested), routes: auth, vehicles (intake/list/detail/retry/corrections/export.csv/stream SSE), stores CRUD with charge validation, webhooks/hermes (raw-body HMAC, idempotent, transition-enforced, immutable events, RAG audit fields), health/ready. Redis pub on every vehicle change. Unit tests: webhookAuth signature + session token.

### Task 6: `apps/worker`
- [ ] BullMQ workers: freightCheck (fetch workbook from `DISPATCH_WORKBOOK_URL|PATH`, parse, calculate; found ⇒ READY + enqueue hermes-dispatch; miss ⇒ AWAITING_FREIGHT + delayed retry; exhausted ⇒ ACTION_REQUIRED), hermesDispatch (conditional-update idempotency guard, POST to HERMES_ENDPOINT with Bearer token, payload incl. store config, freight evidence, corrections, callback URL, request ID; failure ⇒ release guard + BullMQ retry). Publishes Redis updates, records VehicleEvents.

### Task 7: `apps/web`
- [ ] Next 15 App Router; rewrites `/api/*` → API_URL; cookie-presence middleware redirect to /login; global CSS design system (dark command-center, CSS variables); views: Command Center Kanban (3 lanes, SSE + reconnect + polling fallback, cards w/ masked VIN + accessible full VIN, next check time, failure reason), Intake (store dropdown, live VIN validation, bulk CSV with preview/per-row errors), Completed Ledger (filters, pagination, CSV export link), Vehicle detail (timeline, freight evidence, run summary, correction form, guarded Retry), Store Settings (aliases + charges w/ computed total, mismatch rejected). Loading/empty/error states, keyboard/dialog accessibility, responsive.

### Task 8: Ops & docs
- [ ] Dockerfiles ×3, railway.json ×3, .github/workflows/ci.yml (install → generate → build → typecheck → lint → test), README (architecture, ownership, setup, Railway, Hermes/Orgo webhook setup, status model, retry, RAG loop, runbook), docs/architecture.md, docs/hermes-contract.md, docs/railway.md, docs/runbook.md (incl. secret rotation; Railway tokens never in repo).

### Task 9: Verification gate
- [ ] `pnpm install`, `prisma generate`, `pnpm -r build`, `pnpm -r typecheck`, `pnpm lint`, `pnpm -r test`; spin docker-compose Postgres+Redis, `db:push` + seed to validate schema. All green ⇒ single initial commit; otherwise report failures, no commit.
