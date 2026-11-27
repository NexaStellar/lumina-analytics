# Lumina Analytics

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Stellar](https://img.shields.io/badge/Stellar-Analytics-purple)](https://stellar.org)

Lumina is an early-stage Stellar analytics prototype. It is not a finished dashboard or production monitoring service.

## Current implementation

The backend currently provides:

- A Horizon client for transactions, accounts, assets, order books, trades, network statistics, search, and streams.
- A Soroban RPC service for bounded pages of recent contract events. Results are limited to the configured RPC node's retention window and are not a complete historical archive.
- Horizon paginated query methods reject limits outside the integer range 1–200 before making a request.
- A read-only REST API mounted at `/api/v1` for network stats, transactions, accounts, assets, and search, plus a `/health` endpoint.

The repository does not yet contain a running frontend, persistent analytics database, WebSocket application server, alerting system, or data-export implementation. The architecture descriptions in older material are not implemented interfaces.

This project has not received a security audit. Do not rely on it for production monitoring or financial decisions.

## Requirements

- Node.js 22.12 or newer
- npm

## Backend development

```bash
cd backend
npm ci
npm run lint
npm run typecheck
npm test -- --run
npm run build
```

The tests use mocked Horizon and Soroban responses; they do not require live network access.

## Configuration

The backend reads `API_HOST` and `API_PORT` for its bind address (default
`127.0.0.1:4000`), `NETWORK` (`testnet` by default), and optional `HORIZON_URL`
override. The default Horizon endpoint follows the selected network.
`HorizonService` also accepts a URL and network when constructed directly.
`SorobanService` reads `SOROBAN_RPC_URL` and defaults to the Stellar testnet RPC
endpoint.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [open issues](https://github.com/NexaStellar/lumina-analytics/issues) for the current contribution scope.

## License

MIT. See [LICENSE](LICENSE).
