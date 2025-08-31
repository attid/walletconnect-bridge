# WalletConnect Redis Bridge (Stellar‑focused)

Thin WalletConnect v2 bridge that connects Stellar wallets to dApps and delegates signing to a backend over Redis. Built with Reown WalletKit, Node.js/TypeScript, and designed to interop with Python backends (e.g., FastStream) via Redis Lists and BinaryMessageFormatV1.

## Why

Originally attempted to pair `pywalletconnect` with `stellar-sdk`, but it proved brittle for our needs. This bridge replaces the direct client with a minimal Redis‑based flow that’s:

- Reliable: clear, observable queues and JSON/binary envelopes
- Extensible: Stellar‑first today, easy to add other chains tomorrow
- Decoupled: UI/dApp via WalletConnect, signing via your own broker service

Keywords: WalletConnect v2, Reown WalletKit, Stellar, XDR, Redis, Lists, Pub/Sub, FastStream, BinaryMessageFormatV1, Node.js, TypeScript, Docker.

## What It Does

- Pairs a Stellar account to a dApp (WalletConnect v2, Reown WalletKit)
- Emits pairing/session events to Redis
- Forwards signing requests (e.g., `stellar_signAndSubmitXDR`) to your broker via Redis
- Accepts broker replies and passes them back to the dApp

See full protocol and message formats in `walletconnect-bridge.md`.

## Requirements

- Redis 6/7 reachable from the container
- WalletConnect Cloud project id (WC_PROJECT_ID). Create one at https://dashboard.reown.com/

## Configuration

Environment variables:

- `REDIS_URL` (required): Redis connection string, e.g. `redis://127.0.0.1:6379/5`
- `WC_PROJECT_ID` (optional): Your Reown/WalletConnect project id. If not set, the bridge uses the embedded default. Treat it as a public identifier.

## Build & Run (Docker)

Build:

```bash
docker build -t wc-bridge -f Dockerfile.tsfs .
```

Run (Linux host networking):

```bash
docker run --rm --network host \
  -e REDIS_URL=redis://127.0.0.1:6379/5 \
  -e WC_PROJECT_ID=<your_project_id> \
  wc-bridge
```

If the host gateway name `host.docker.internal` is unavailable, use `--network host` or `--add-host=host.docker.internal:host-gateway`.

## Operational Notes

- Message transport: Redis Lists for requests/events; replies support both Pub/Sub and Lists for compatibility.
- Binary format: Inbound pairing and (optionally) replies support FastStream’s `BinaryMessageFormatV1`. JSON envelope fallback is also supported.
- Logging: structured JSON logs (verbose) with XDR included for debugging.
- Persistence: WalletKit/Core state is in‑memory by default. See `walletconnect-bridge.md` for persistence options.

## Extending Beyond Stellar

The bridge is Stellar‑focused (accounts `stellar:pubnet:<address>`, methods like `stellar_signXDR`/`stellar_signAndSubmitXDR`). To add new chains, map their namespaces, chains, accounts formatting, and supported methods in the approval logic.

## Full Technical Spec

All protocol details, Redis keys, message formats (BinaryMessageFormatV1 and JSON envelope), pairing/session flows, and compatibility notes live in:

- `walletconnect-bridge.md`

Read it carefully before integrating your broker.
