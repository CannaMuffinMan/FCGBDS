# Contributing

## Rules

1. Keep the core free of vendor-specific product logic (payments, streaming platforms, chain/wallet flows).
2. Do not add secrets, customer data, or private hostnames.
3. New signals should be configurable and tested with both a catch case and a false-positive case when practical.
4. Do not inflate telemetry. Observed and enforced counts stay separate.

## Checks

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Pull requests

Describe the signal or bug, how to reproduce, and any default-behavior change. Breaking changes belong in the PR description, not in marketing copy.
