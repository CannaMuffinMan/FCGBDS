# Bot defense for any API or platform

FCGBDS is self-hosted bot defense for **your** API: signup, login, posting, user reports, payments-adjacent routes, and any custom path you name. One process can cover several apps, each with its own key, policies, and stats. You run it. It does not call out to another company’s service.

Version 2.2.0 scores a request and then does what **your policy** says: allow, log, flag for moderation, shadow or rate-limit, challenge, or block. Wire the events into your own reporting or self-healing. A public stats page is an optional add-on and is documented at the end.

It will not stop a determined attacker with a real browser. See [Limitations](#limitations) and `docs/THREAT-MODEL.md`. The 10-minute API guide is `INTEGRATION-GUIDE.md`.

## Five-minute service quick start

```bash
git clone https://github.com/CannaMuffinMan/FCGBDS.git
cd FCGBDS
cp .env.example .env
npm install
npm test
npm run dev
```

```bash
curl -s http://127.0.0.1:3001/health
curl -s -D - http://127.0.0.1:3001/login -o /tmp/fcgbds-body.txt
curl -s -D - -A 'curl/8.0' -H 'Content-Type: application/json' \
  -d '{"website":"http://example"}' http://127.0.0.1:3001/login
```

The default mode is `observe`. Both requests are allowed. The second should include `X-FCGBDS-Would-Block: 1`. Set `FCGBDS_MODE=enforce` to return **403** or **429** with a JSON or HTML body that says why. FCGBDS does not answer with an empty 429.

Docker, with Redis:

```bash
docker compose up --build
```

Set `FCGBDS_DASHBOARD_PASSWORD` and open `http://127.0.0.1:3001/dashboard`. Counts are checks issued, passed, not verified, and stopped for this process, split by app id when you create apps. The mode toggle is stored in the configured store.

Protect a specific API by creating an app (`POST /v1/apps` with the admin token) and sending that app key on `POST /v1/evaluate`. Policies and stats stay on that app. See `INTEGRATION-GUIDE.md`.

## What a request is scored on

| Signal | When it adds score |
| --- | --- |
| IP / ASN | Private address seen behind a forwarding header, or an ASN you listed in `FCGBDS_DATACENTER_ASNS` |
| Device | Client-Hints brand disagrees with a Chrome User-Agent |
| Header consistency | Host does not match `FCGBDS_EXPECTED_HOSTNAME`, or a browser-like UA is missing Accept or Sec-Fetch |
| TLS class | Your edge sends `X-FCGBDS-TLS-Class: browser` or `automated` and it disagrees with the User-Agent. Unset means no score |
| Velocity | IP, route, or device hash crosses the profile window |
| Payload | Very large or high-cardinality JSON, or the same body repeated |
| Token shape | Bearer value that is not three JWT segments, or whitespace in a token header |
| Automation | User-Agent substrings such as `curl/`, `python-requests`, `HeadlessChrome` |
| Replay | Reused `Idempotency-Key` or `X-Nonce` |
| Honeypot | Non-empty configured form field |
| IP reputation | Only if you set `FCGBDS_REPUTATION_URL` or pass a hook. Score is capped by `FCGBDS_REPUTATION_CAP` (default 50) |
| Deny list | Matching IP, CIDR, User-Agent substring, or path is treated as a block |

Thresholds default to 60 (visitor check) and 90 (block). Auth-like prefixes use 50 and 80.

## Visitor check

In enforce mode a challenge is HTTP 429 and a JSON body with `error: challenge_required`, or an HTML form when `Accept` contains `text/html`. The form asks the visitor to type CONTINUE. `POST /v1/challenge/verify` with the right answer returns a clearance token bound to the IP hash for 30 minutes. Send it as `X-FCGBDS-Clearance` or cookie `fcgbds_clearance`.

## REST API

`openapi/openapi.yaml` is the contract. Base URL is wherever you run the process.

- `POST /v1/evaluate` — body `{ method, path, ip, headers, body }`. When `FCGBDS_API_TOKEN` is set, send `Authorization: Bearer`.
- `POST /v1/challenge/verify`
- `GET /v1/stats`, `POST /v1/mode`, `GET`/`PUT /v1/policies`
- `GET`/`POST /v1/lists/allow` and `/v1/lists/deny`
- `GET /v1/events` — server-sent events for the admin token or dashboard session
- `GET /v1/forward-auth` — for Caddy and NGINX. Send `X-Original-URI` and `X-Original-Method`. NGINX should also send `X-FCGBDS-Nginx: 1` so a visitor check is status 401 (auth_request drops other codes) with a JSON body
- `GET /health`, `GET /ready`, `GET /metrics` (Prometheus text)
Decision webhooks: set `FCGBDS_EVENT_WEBHOOK_URL`, or a per-app `webhookUrl`, to an endpoint you run. The JSON is `{ "type": "bot-defense.decision", "event" }`. The event has the app id, intended action (`log`, `flag`, `shadow`, `challenge`, `block`), path, score, and an IP hash prefix. It does not include the full IP or the request body. Point that at your moderation queue or a job that tightens a policy.

## Quick start per platform

### Express (in process)

```ts
import express from 'express';
import { AlertSink, createMiddleware, createStore, loadConfigFromEnv, Telemetry } from 'fcgbds';

const config = loadConfigFromEnv();
const store = await createStore({ redisUrl: config.redisUrl, prefix: config.redisKeyPrefix, maxKeys: config.storeMaxKeys });
const app = express();
app.use(express.json());
app.use(createMiddleware({ config, store, telemetry: new Telemetry(), alerts: new AlertSink() }));
```

### TypeScript client (your instance)

```ts
import { FcgbdsClient } from 'fcgbds';
const client = new FcgbdsClient(process.env.FCGBDS_URL || 'http://127.0.0.1:3001', process.env.FCGBDS_API_TOKEN);
const decision = await client.evaluate({ method: 'POST', path: '/login', ip: '203.0.113.8', headers: { 'user-agent': 'example' } });
```

### Fastify

```ts
import { createStore, fcgbdsFastifyPlugin, loadConfigFromEnv } from 'fcgbds';
const config = loadConfigFromEnv();
const store = await createStore({ prefix: config.redisKeyPrefix, maxKeys: config.storeMaxKeys });
fastify.register(fcgbdsFastifyPlugin({ config, store }));
```

### Next.js middleware

```ts
import { guardNextRequest } from 'fcgbds';
export async function middleware(request: Request) {
  const denied = await guardNextRequest(request, {
    baseUrl: process.env.FCGBDS_URL || 'http://127.0.0.1:3001',
    apiToken: process.env.FCGBDS_API_TOKEN,
  });
  return denied ?? NextResponse.next();
}
```

### Node `http`

```ts
import http from 'http';
import { createNodeHttpMiddleware, createStore, loadConfigFromEnv } from 'fcgbds';
const config = loadConfigFromEnv();
const store = await createStore({ prefix: config.redisKeyPrefix, maxKeys: config.storeMaxKeys });
const guard = createNodeHttpMiddleware({ config, store });
http.createServer((req, res) => { void guard(req, res, () => { res.end('ok'); }); }).listen(8080);
```

### Go

```bash
cd sdk/go && go test ./...
```

```go
import fcgbds "github.com/CannaMuffinMan/FCGBDS/sdk/go"

client := &fcgbds.Client{BaseURL: os.Getenv("FCGBDS_URL"), Token: os.Getenv("FCGBDS_API_TOKEN")}
http.ListenAndServe(":8080", fcgbds.Middleware(client, yourHandler))
```

Module path: `github.com/CannaMuffinMan/FCGBDS/sdk/go`.

### Python (ASGI, WSGI, FastAPI, Flask)

```bash
PYTHONPATH=sdk/python python3 sdk/python/tests/test_middleware.py
```

```python
from fcgbds.asgi import asgi_middleware
from fcgbds.client import FcgbdsClient
from fcgbds.wsgi import wsgi_middleware

client = FcgbdsClient("http://127.0.0.1:3001", api_token="")
# FastAPI / Starlette: app = asgi_middleware(client)(app)
# Flask: app.wsgi_app = wsgi_middleware(client, app.wsgi_app)
```

### Cloudflare Workers

`adapters/cloudflare/worker.js` reads `FCGBDS_URL` and optional `FCGBDS_API_TOKEN` from the Worker environment and returns the instance’s JSON decision. It does not use a shared KV namespace from this project.

### NGINX and Caddy

- `deploy/nginx/fcgbds.conf`
- `deploy/caddy/Caddyfile`

Both call `/v1/forward-auth` on your instance. Replace the token and upstream addresses.

### Postgres, SQLite, Redis

```bash
# sqlite
FCGBDS_STORE=sqlite FCGBDS_SQLITE_PATH=./fcgbds.sqlite npm run dev

# postgres — apply migrations/postgres/001_init.sql (the process also runs it on connect)
FCGBDS_STORE=postgres FCGBDS_POSTGRES_URL=postgres://user:pass@127.0.0.1:5432/fcgbds npm run dev
```

Redis remains `REDIS_URL` or `FCGBDS_STORE=redis`. If Redis errors, counters fall back to memory and `/ready` returns 503 while `/health` stays 200.

### Helm, Fly, Railway

- Chart: `deploy/helm/fcgbds`
- `fly.toml` — set `app` to your Fly app name and provide secrets with `fly secrets set`
- `railway.toml` — Dockerfile deploy; set variables in the Railway service

## Configuration

Copy `.env.example`. Empty `FCGBDS_CHALLENGE_SECRET` uses a development default that anyone who reads this code can forge. Set a long random value anywhere the process is shared.

## Tests

```bash
npm test
npm run test:adapters
npm run harness
```

`npm run harness` prints catch rate and false-positive rate for the bundled fixtures only.

## Docs

- `docs/OPERATIONAL-RUNBOOK.md`
- `docs/THREAT-MODEL.md`
- `SECURITY.md`
- `CHANGELOG.md`

## Limitations

- A client that looks like a normal browser, stays under your limits, and passes the text check is allowed.
- TLS and ASN signals do nothing until your edge sets the headers.
- The reputation hook is your endpoint. There is no bundled IP database.
- Memory counters are per process. SQLite is one file and one writer. Use Redis or Postgres for more than one replica, and expect fixed windows there rather than the in-memory sliding window.
- Allowlists that match only a User-Agent can be spoofed.
- Webhook allowlisting checks that a header name is present. It does not verify the signature.
- Dashboard numbers are counts since process start (mode, lists, and app records are what the store saved). They are not a lifetime block total.
- Custom signal hooks run in-process. Over HTTP, send `extraSignals` you already computed; each score is capped at 50. The service does not load your code.
- `shadow` with `rate_limit` returns 429 only when the velocity signal also fired. Otherwise the request continues with `X-FCGBDS-Shadow: 1` and your API decides what to hide or slow down.
- `flag` and `log` never change the HTTP status. They emit an event.
- App keys and per-app policies exist after `POST /v1/apps`. Until then there is one implicit `default` app. Keys are shown once.

## Optional public stats

If you want a public counter, set `FCGBDS_WALL_PUBLIC=true`. `GET /v1/wall` returns checks issued, passed, not verified, and stopped. `/wall.js` fills an element with `[data-fcgbds-wall]`. This is a demo widget, not part of protecting an API. Leave it off unless you mean to publish those counts.
- No claim of complete coverage or a measured false-positive rate on your traffic.

## License

MIT. See `LICENSE`.
