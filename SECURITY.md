# Security policy

## Reporting

If you believe you have found a vulnerability in this repository, open a private GitHub security advisory if available, or email the maintainer listed on the GitHub profile. Do not file a public issue with exploit details.

## Scope

In scope: the Node evaluation core, store, challenge tokens, and the example Cloudflare Worker.

Out of scope: deployments you run, secrets you put in `.env`, and third-party bots spoofing allowlisted User-Agents.

## Handling data

Do not log raw request bodies, tokens, or full IP addresses in production logs. The demo server does not persist payloads.

Rotate `FCGBDS_CHALLENGE_SECRET` if it leaks. Existing challenge tokens become invalid.

Never commit real hostnames, API keys, or customer data to this public repository.
