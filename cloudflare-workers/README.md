# Cloudflare Worker test harness

These workers send HTTP requests with `fetch()` and record how the FCGBDS gate responds. They do not merge, deploy, or send live traffic by themselves. A person still has to deploy a worker and call `POST /run`.

## What a run actually is

`fetch()` inside a Worker is not a browser. Setting `User-Agent` to a string that contains `HeadlessChrome`, `Playwright`, `Selenium`, or `node-fetch` only proves that the gate's user-agent heuristic saw that string. It does not execute page JavaScript, WebDriver, or a real Chrome process.

Ground truth stays in the harness report: `expectBlock`, lane, and run id. Those values are not sent as request headers. The workers also strip these headers if a wave template includes them:

- `X-Bot-Test`
- `X-Legit-Traffic`
- `X-Test-Run-Id`
- `X-Swarm-*`
- `X-Automation-Intent`
- `X-Request-Burst`
- `X-FCG-Test-Token`

`X-FCG-Test-Token` is a WAF bypass. Sending it to the host under test would let traffic skip a control the gate is supposed to exercise, so scored requests do not include it.

## How a request is graded

A catch is a gate decision, not an HTTP status by itself.

- `code: "request_blocked"` or `action: "block"` is a block.
- `code: "challenge_required"` or `action: "challenge"` is a challenge.
- `400` and `401` are not bot catches.
- The report keeps `score` and `ruleIds` from the gate body.

Confusion counts are per wave and per rule:

- TP: hostile lane, gate blocked or challenged
- FN: hostile lane, gate did not
- FP: legit lane, gate blocked or challenged (`FAILURE` and `FALSE_POS`)
- TN: legit lane, gate did not

A legit lane can fail. `FAILURE` is set on both false negatives and false positives.

## Paths the default gate does not cover

The default protected list matches `src/index.ts`: auth login/register, email login/register, `/api/user/profile`, `/api/payment`, and `/api/chat-bridge/session/validate`.

These worker paths are outside that list unless a run overrides it:

- `/api/platform/interact`
- `/api/wallet/status`
- `/api/health`
- `/api/bot-defense/stats`
- `/api/ecosystem/feed`

The report lists them under `gate.outsideProtectedPaths`. Status codes there are not defense results.

Override the list for a run with `protectedPaths` on the `/run` JSON body, or with the worker env var `BOT_DEFENSE_PATHS` (comma-separated). The override is a label for grading. It does not change the target server's middleware.

## Real headless browser lanes (not implemented)

A later lane can run Playwright (or Puppeteer) outside the Worker, from a job that launches Chromium, opens the site, and performs the same register/login steps a person would. That job would record the gate's JSON (`code`, `score`, `ruleIds`) the same way this harness does, and it would still keep ground truth out of request headers. This repository does not ship that runner. Until it does, worker reports are header-and-body probes only.
