# Security policy

## Reporting

If you believe you have found a vulnerability in this repository, open a private GitHub security advisory if available, or contact the maintainer listed on the GitHub profile. Do not file a public issue with exploit details.

## Scope

In scope: the evaluation core, stores, challenge and clearance tokens, the HTTP API, and the adapters in this repository.

Out of scope: deployments you run, secrets you put in `.env`, and third-party clients spoofing allowlisted User-Agents.

## Data

See `docs/THREAT-MODEL.md` for privacy and retention. Do not log raw bodies or full IP addresses in your own extensions. Rotate `FCGBDS_CHALLENGE_SECRET`, `FCGBDS_API_TOKEN`, and `FCGBDS_DASHBOARD_PASSWORD` if they leak.

Set `FCGBDS_API_TOKEN` before exposing the process beyond localhost. Without it, `POST /v1/evaluate` is open.

Never commit real hostnames, API keys, or customer data to this public repository.
