# FCGBDS — Forever Couch Gang Bot Defense System

MIT-licensed bot defense you can run on your own server. It scores requests from multiple signals, defaults to **observe** (log what it would have blocked), and can **enforce** challenge or block once you are ready.

This is not a guarantee against abuse. See [Limitations](#limitations).

## Five-minute quick start

```bash
git clone https://github.com/CannaMuffinMan/FCGBDS.git
cd FCGBDS
cp .env.example .env
npm install
npm test
npm run dev
```

Check it:

```bash
curl -s http://127.0.0.1:3001/health
curl -s -D - -o /dev/null http://127.0.0.1:3001/login
curl -s -D - -o /dev/null -A 'curl/8.0' -H 'Content-Type: application/json' \
  -d '{"website":"http://example"}' http://127.0.0.1:3001/login
```

In observe mode both requests succeed. The second should include `X-FCGBDS-Would-Block: 1`. Set `FCGBDS_MODE=enforce` when you want 403/429 responses.

Docker:

```bash
docker compose up --build
```

## What it does

| Signal | Role |
| --- | --- |
| IP / ASN | Private forwarded IPs; optional datacenter ASN list from a trusted header |
| Device | Header-derived fingerprint hash and Client-Hints mismatch |
| Header consistency | Host check (if configured), missing browser Client Hints / Accept / UA |
| Per-route velocity | Sliding windows for IP, route+IP, and device |
| Payload | Oversized or high-cardinality bodies; repeat signatures |
| Token anomalies | Malformed or oversized bearer tokens |
| Automation / headless | Common bot UAs and explicit automation headers |
| Replay | Idempotency-key / nonce reuse and payload repeats |
| Honeypots | Configurable unused form fields |

**Observe** (default): always allow; emit `X-FCGBDS-Would-Block` / `X-FCGBDS-Would-Challenge` and metrics.

**Enforce**: return 429 (accessible text challenge) or 403.

## Integrate as middleware

```ts
import express from 'express';
import { createMiddleware, createStore, loadConfigFromEnv, Telemetry, AlertSink } from 'fcgbds';

const config = loadConfigFromEnv();
const store = await createStore({
  redisUrl: config.redisUrl,
  prefix: config.redisKeyPrefix,
  maxKeys: config.storeMaxKeys,
});
const app = express();
app.use(express.json());
app.use(createMiddleware({
  config,
  store,
  telemetry: new Telemetry(),
  alerts: new AlertSink(),
}));
```

Route **profiles** in config choose observe vs enforce, velocity limits, and **fail-open** vs **fail-closed** if the evaluator throws. Auth-like prefixes default to fail-closed; webhooks and `/` default to fail-open. Redis errors fall back to in-process memory (shared state is lost across processes until Redis returns).

## State

- **Redis** when `REDIS_URL` is set and reachable
- **In-memory** otherwise, or if Redis fails after connect

Fail-open vs fail-closed applies to evaluator exceptions, not to Redis fallback. Redis fallback keeps the process serving traffic with local counters.

## Allowlists

- Known-good bots by User-Agent (Googlebot, Bingbot, Cloudflare health checks by default)
- Webhook path prefixes; optional required signature header name (the header value is not verified — verify signatures in your own handler)

## Telemetry

`GET /metrics` reports **live** vs **practice** (`X-FCGBDS-Lane: practice`) and **observed** vs **enforced** counts separately. Observed “would block” is not counted as an enforced block.

## Simulation harness

```bash
npm run harness
```

Labeled good/bad requests report `catchRate` and `falsePositiveRate`. These numbers are for the bundled fixtures, not your production mix.

## Cloudflare Worker

See `examples/cloudflare-worker/` for a header/honeypot subset that runs at the edge without Redis. It is an example, not a full port of the Node core.

## Configuration

Copy `.env.example`. All hostnames and secrets are yours. `FCGBDS_CHALLENGE_SECRET` should be a long random string in any shared deployment; if empty, challenge tokens are signed with a development default and will not survive a reasoned attack.

## Docs

- `docs/OPERATIONAL-RUNBOOK.md` — modes, profiles, Redis, alerts
- `SECURITY.md` — reporting and handling
- `CONTRIBUTING.md`

## Limitations

- Determined attackers with real browsers, residential proxies, and solved challenges will get through.
- ASN and datacenter scoring only work if you pass a trusted ASN header (for example from your edge).
- Memory store is per process; use Redis for more than one instance.
- Allowlisted bots can be spoofed unless you also pin IP ranges.
- Webhook allowlisting does not validate cryptographic signatures.
- No claim of 100% protection, zero false positives, or replacement for application-level auth.

## License

MIT. Attribution is appreciated; it is not required beyond the license notice.
