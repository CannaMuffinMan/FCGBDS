# Threat model, privacy, and retention

## What this process is for

FCGBDS scores HTTP requests with local signals and optional hooks you configure. It is one control in front of your application. It does not authenticate users and it does not prove a client is a person.

## Assets

- The challenge and session secrets
- The API token and dashboard password
- Counter keys (IP, path, device hash) in the store you choose
- Allow and deny lists

## Trust boundaries

- The Node process and its store are yours. There is no phone-home path in this repository.
- `FCGBDS_REPUTATION_URL` and `FCGBDS_EVENT_WEBHOOK_URL` are called only when you set them.
- ASN and TLS class are meaningful only when your edge sets those headers. Clients can spoof them if they reach the process directly.
- Known-good bot allowlists match User-Agent substrings unless you also add CIDR entries.

## What we store

- Sliding or fixed-window counters and nonce keys. Memory and Redis keep them until TTL or eviction. SQLite and Postgres keep rows until the window expires on the next write; they are not a full request log.
- List entries and the saved mode or profiles, if you change them through the API.
- In-process telemetry counts and a ring buffer of decision events. Events include a 16-character SHA-256 prefix of the IP, the path, the score, and signal ids. They do not include bodies, tokens, or the full IP.
- Webhook deliveries send that same event object.

## Retention

Restarting the process clears memory telemetry and the event buffer. Redis keys expire with their TTL. Delete `fcgbds.sqlite` or the Postgres tables to drop durable lists and counters. Dashboard sessions last 12 hours. Visitor-check tokens last 10 minutes. Clearance lasts 30 minutes and only for the same IP hash.

## Out of scope

Determined clients that use a real browser, solve the text check, and stay under your velocity limits will be allowed. That is expected. Cryptographic webhook signature checks belong in your application; this project only checks that a configured header is present.
