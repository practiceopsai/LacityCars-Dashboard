# Railway deployment

One repo → three Railway services plus managed Postgres and Redis.
Never commit Railway tokens or any credentials to this repo; set them as
Railway service variables (and GitHub Actions secrets for CI).

CLI uploads use the root `Dockerfile` and `railway.json`. The same image is
built for all application services; `APP_SERVICE` selects the process:
`api`, `worker`, or `web`. The nested service configs remain available when
deploying through a GitHub-linked Railway service.

## 1. Databases

In a new Railway project add **PostgreSQL** and **Redis** plugins/services.

## 2. Services

Create three services from this GitHub repo. For each, Railway picks up the
`railway.json` when you set the service **Root Directory**; the Dockerfiles
expect the **build context to be the repo root** (they are referenced by path).

| Service | Config file | Dockerfile | Public? |
| --- | --- | --- | --- |
| `api` | `apps/api/railway.json` | `apps/api/Dockerfile` | yes (Hermes must reach the webhook) |
| `worker` | `apps/worker/railway.json` | `apps/worker/Dockerfile` | no |
| `web` | `apps/web/railway.json` | `apps/web/Dockerfile` | yes (operator dashboard) |

Health checks: api → `/ready`, web → `/login`. The worker has no HTTP server.

## 3. Variables

Use Railway variable references for infrastructure:

**api**
```
APP_SERVICE    = api
DATABASE_URL   = ${{Postgres.DATABASE_URL}}
REDIS_URL      = ${{Redis.REDIS_URL}}
WEB_ORIGIN     = https://<web-domain>
SESSION_SECRET         = <generate: openssl rand -hex 32>
OPERATOR_PASSWORD      = <strong operator password>
HERMES_WEBHOOK_SECRET  = <generate: openssl rand -hex 32>
NODE_ENV       = production
```

**worker**
```
APP_SERVICE       = worker
DATABASE_URL   = ${{Postgres.DATABASE_URL}}
REDIS_URL      = ${{Redis.REDIS_URL}}
HERMES_ENDPOINT   = https://www.orgo.ai/api/computers/<computer-id>/bash
HERMES_LOCAL_WEBHOOK_URL = http://127.0.0.1:8644/webhooks/vehicle-stocking
HERMES_TRIGGER_SECRET = <same HMAC secret as the Hermes webhook route>
HERMES_PROXY_TOKEN = <Orgo server-side API token; never expose to the browser>
PUBLIC_API_URL    = https://<api-domain>
DISPATCH_WORKBOOK_URL = <https URL of the current dispatch workbook>
NODE_ENV       = production
```

**web**
```
APP_SERVICE = web
API_URL  = https://<api-domain>      # needed at BUILD time (rewrite target).
                                     # Use Railway's private networking URL
                                     # (http://api.railway.internal:PORT) if preferred.
NODE_ENV = production
```

> `API_URL` is read when the Next.js build runs — set it before the first
> deploy and redeploy web after changing it.

## 4. Database setup

The API service runs the schema push and deterministic seed as its Railway
pre-deploy command. For a manual setup or recovery run, use:

From your machine (with `DATABASE_URL` pointed at the Railway Postgres):

```bash
pnpm --filter @lacity/database db:push
pnpm --filter @lacity/database db:seed
```

This creates the schema and seeds LA City + Columbia City deterministically
(safe to re-run).

## 5. Hermes side

Configure the Hermes agent on the Orgo computer with:
- the native `vehicle-stocking` route and its `HERMES_TRIGGER_SECRET`,
- Orgo computer API transport authentication (`HERMES_PROXY_TOKEN`),
- the callback signing secret (`HERMES_WEBHOOK_SECRET`),
- the callback URL `https://<api-domain>/api/webhooks/hermes`.

See [hermes-contract.md](hermes-contract.md).
