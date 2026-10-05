# Protect your API in 10 minutes

FCGBDS sits in front of routes you choose. The examples below are a generic REST API: signup, login, an abuse report, and a machine client. None of them depend on a particular product.

## 1. Run your instance

```bash
cp .env.example .env
npm install
npm run dev
```

Set `FCGBDS_API_TOKEN` to a long random string before any other machine can reach the port. Set `FCGBDS_CHALLENGE_SECRET` the same way. Leave `FCGBDS_MODE=observe` until a real client still looks right in the response headers.

## 2. Ask the service about one request

From your API process, after you know the method, path, and client IP:

```bash
curl -s http://127.0.0.1:3001/v1/evaluate \
  -H 'authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'content-type: application/json' \
  -d '{
    "method": "POST",
    "path": "/v1/comments",
    "ip": "203.0.113.10",
    "headers": { "user-agent": "example-app" }
  }'
```

`result.action` is what to do now. `result.intendedAction` is what the policy would do in enforce mode. `response` is null when the caller should continue. When it is set, return that JSON and status to your client. Do not replace it with an empty 429.

In observe mode your handler should still continue, and you can queue `intendedAction` for review.

## 3. Several apps on one service

```bash
curl -s http://127.0.0.1:3001/v1/apps \
  -H 'authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"id":"shop","name":"Shop API","mode":"enforce"}'
```

The response includes `apiKey` once. The shop API sends that key on `/v1/evaluate`. A second app gets a different key, its own `profiles`, and its own row in `GET /v1/stats` under `apps`. The admin token still sees every app. This is not a hard multi-tenant security boundary against a stolen admin token.

## Signup

Default profile id `signup` matches `/signup` and `/register` (fail-closed, tighter velocity). A custom rule can flag disposable-email scores you compute:

```json
{
  "id": "signup",
  "pathPrefixes": ["/signup"],
  "failurePolicy": "fail-closed",
  "actionRules": [
    { "minScore": 40, "action": "challenge" },
    { "minScore": 80, "action": "block" }
  ]
}
```

Put that array on the app as `profiles`, or `PUT /v1/policies` for the single-app install. Send the email check as a signal you already decided:

```json
"extraSignals": [{ "id": "disposable_email", "score": 45 }]
```

Each extra signal is capped at 50. In-process code can instead pass a `SignalHook` to `evaluateRequest`. The HTTP service does not import your hook.

## Login

Profile id `login` matches `/login`, `/session`, and `/api/auth`. Thresholds default to challenge at 50 and block at 80. Failed-password counting stays in your app; if you want it in the score, send `extraSignals` such as `{ "id": "password_failures", "score": 30 }`.

## User report / abuse

Profile id `reports` matches `/reports`, `/abuse`, and `/api/reports`. To queue reviews without blocking the report:

```json
{
  "id": "reports",
  "pathPrefixes": ["/api/reports"],
  "failurePolicy": "fail-closed",
  "actionRules": [
    { "minScore": 25, "action": "flag" },
    { "minScore": 90, "action": "block" }
  ]
}
```

`flag` returns no error body. Your webhook receives `action: "flag"`. Point `webhookUrl` on the app, or `FCGBDS_EVENT_WEBHOOK_URL`, at the worker that opens a moderation ticket. `log` is the same shape with a lower-priority action name.

## Machine clients and API keys

Allow a known job without disabling the route for browsers. `matchType: "header"` compares a header value with `name:substring`:

```bash
curl -s http://127.0.0.1:3001/v1/lists/allow \
  -H 'authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"matchType":"header","value":"x-api-key:job_example_","note":"billing job"}'
```

A request with `x-api-key: job_example_…` is allowlisted (score 0). The substring is not a cryptographic check. Rotate keys in your app; delete the list entry when you retire one. Prefer pinning `ip` or `cidr` on the same kind of entry only if that alone is enough, or keep the header check and verify the key in the route that actually performs the action.

## Shadow and rate limit

```json
{
  "id": "posts",
  "pathPrefixes": ["/posts"],
  "failurePolicy": "fail-open",
  "shadow": "rate_limit",
  "velocity": { "maxHits": 20, "windowMs": 60000 },
  "actionRules": [{ "minScore": 50, "action": "shadow" }]
}
```

If the score says shadow and velocity has **not** fired, the HTTP call continues and `X-FCGBDS-Shadow` is `1`. Your handler can hide the post from other users. If velocity has fired and mode is enforce, the response is **429** with `error: "rate_limited"` and a message. `shadow: "mark"` never returns that 429.

## What you still do in your API

- Verify real credentials, session cookies, and payment signatures.
- Decide what a `flag` or `shadow` means in your product.
- Treat observe-mode headers as data, not as a block.
