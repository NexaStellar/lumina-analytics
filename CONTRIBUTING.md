# Contributing

Thanks for helping improve Lumina Analytics. This repository is an early-stage
backend prototype, not a finished dashboard or production monitoring service.
Keep changes aligned with the implementation described in `README.md`.

## Development setup

Requirements: Node.js 22.12 or newer and npm.

```bash
cd backend
npm ci
npm run lint
npm run typecheck
npm test -- --run
npm run build
```

Tests use mocked Horizon and Soroban responses; do not make them depend on live
network services.

## Pull requests

- Describe the behavior change and link related issues.
- Add focused tests for changed behavior, including invalid input and upstream
  failure cases where relevant.
- Update the README when public API behavior changes.
- Run all backend checks before requesting review.
- Do not commit credentials, private keys, production data, or `.env` files.

## Drips Wave

Only work on issues listed in an active Wave Program and follow the program's
application and assignment process. Repository approval is decided by program
organizers; draft backlog entries do not grant eligibility.

See the [Code of Conduct](CODE_OF_CONDUCT.md) and [security policy](.github/SECURITY.md).
