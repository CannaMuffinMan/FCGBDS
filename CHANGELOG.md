# Changelog

## 2.1.0

Self-hosted integration release. The evaluator from 2.0.0 stays the default. Nothing in this version calls a Forever Couch Gang service.

- REST API with `openapi/openapi.yaml`: evaluate, visitor check, policies, allow and deny lists, mode, stats, SSE events, forward-auth, health, readiness.
- Prometheus text at `GET /metrics`. JSON stats moved to `GET /v1/stats`.
- Stores: memory, Redis, Postgres (`migrations/postgres`), SQLite (`migrations/sqlite`).
- Signals added: TLS class header vs User-Agent, operator IP reputation hook, deny list.
- Clearance tokens after a passed visitor check, bound to an IP hash.
- Challenge and block HTTP responses always include a JSON or HTML body. NGINX forward-auth maps a visitor check to 401 because `auth_request` does not pass 429 through; the body still names the visitor check.
- Dashboard at `/dashboard` when `FCGBDS_DASHBOARD_PASSWORD` is set. Public wall only when `FCGBDS_WALL_PUBLIC=true`.
- TypeScript client, Go client and `net/http` middleware, Python client with ASGI and WSGI middleware, Cloudflare Worker, NGINX and Caddy examples, Helm chart, Fly and Railway templates.

## 2.0.0

Config-driven library and demo server: observe by default, enforce for explicit challenge or block, Redis or memory, route profiles, labeled harness.
