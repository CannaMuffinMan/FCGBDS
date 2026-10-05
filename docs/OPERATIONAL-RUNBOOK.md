# Operational runbook

## Modes

| Mode | Behavior |
| --- | --- |
| `observe` (default) | Requests are allowed. Headers and `/metrics` show would-have blocked/challenged. |
| `enforce` | Challenge at the challenge threshold; block at the block threshold. |

Start in observe. `GET /metrics` is Prometheus text. `GET /v1/stats` (admin token or dashboard session) is JSON, including `recentAlerts`. Set `FCGBDS_MODE=enforce` or `POST /v1/mode` when you want challenge and block responses.

The visitor challenge is a text form (`CONTINUE`) plus a signed token. It is usable without images. In observe mode the middleware does not present it; operators can still open `GET /__fcgbds/challenge`. If challenge verification code throws, observe traffic is not blocked by this layer.

## Route profiles and failure policy

Profiles are first-match on path prefix.

| Profile | Default paths | Failure policy | Notes |
| --- | --- | --- | --- |
| `env-protected` | `FCGBDS_PROTECTED_PATHS` | configurable | Inserted first when env is set |
| `auth` | `/login`, `/register`, `/api/auth` | fail-closed | Evaluator exceptions return 503 |
| `webhooks` | `/webhooks`, `/api/webhooks` | fail-open | Prefer signature checks in your app |
| `default` | `/` | fail-open | Catch-all |

**Fail-open:** on internal errors, call `next()`. **Fail-closed:** 503 JSON `defense_unavailable`.

Redis outages switch counters to local memory. That is not the same as fail-closed: traffic continues, but other processes will not see those counts.

## Allowlists

Tune `knownGoodBots` in code or extend `loadConfigFromEnv` if you need more. For webhooks, set `FCGBDS_WEBHOOK_SIGNATURE_HEADER` to the header your provider sends, then verify the signature yourself.

## Practice vs live traffic

Send `X-FCGBDS-Lane: practice` (header name overridable) from load tests. Metrics keep those counts out of the live bucket.

## Redis

Set `REDIS_URL=redis://localhost:6379`. Keys use `FCGBDS_REDIS_PREFIX`. Docker Compose includes a Redis service.

## Alerts

In-process ring buffer via `AlertSink`. Wire `recent()` to your logger or queue. Nothing is sent off-box by default.
