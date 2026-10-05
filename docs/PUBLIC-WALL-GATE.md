# Publishing checklist

This repository is public. Before every commit:

1. No secrets, tokens, cookies, or private keys.
2. No internal hostnames, personal filesystem paths, or customer identifiers.
3. No payment, wallet, chain, or streaming-platform business logic from a private product.
4. `.env.example` stays placeholders.
5. Telemetry must not phone home.

If a change needs a real hostname, it belongs in the operator's environment, not in git.
