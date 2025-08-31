**Overview**
- Purpose: WalletConnect v2 bridge that pairs a Stellar account with dApps and delegates signing to a broker via Redis.
- Stack: Node.js, Reown WalletKit (`@reown/walletkit`) + WalletConnect Core, Redis (queues), TypeScript.
- Transport: Redis Lists (RPUSH/BLPOP) with support for FastStream BinaryMessageFormatV1 and JSON envelope fallback.

**Environment**
- `REDIS_URL`: Redis connection string (e.g., `redis://127.0.0.1:6379/5`).
- `NODE_ENV`: defaults to `production` in Docker.
- `WC_PROJECT_ID`: WalletConnect Cloud project id. Optional; if not set, a default project id embedded in the code is used. Treat as public identifier (not a secret); set per environment if needed.

**Redis Keys**
- `wc-pairing-request` (List, inbound): enqueue pairing requests from broker/producer.
- `wc-pairing-events` (List, outbound): status/events around pairing/session lifecycle.
- `wc-sign-request-queue` (List, outbound): signing requests emitted to broker.
- `wc-sign-replies:<cid>` (Inbound replies): supports both Pub/Sub (PUBLISH) and List (RPUSH/BLPOP). The bridge subscribes to the channel and, in parallel, polls the list with BLPOP until one path resolves or a timeout occurs.

**Redis Transport Summary**
- Pairing request → bridge: List (`wc-pairing-request`, BLPOP).
- Pairing events ← bridge: List (`wc-pairing-events`, RPUSH).
- Sign request → broker: List (`wc-sign-request-queue`, RPUSH).
- Sign reply ← broker: Pub/Sub (PUBLISH) or List (RPUSH to `wc-sign-replies:<cid>`). The bridge handles both.

**Message Formats**
- BinaryMessageFormatV1 (preferred for inbound from FastStream):
  - Magic: `\x89BIN\r\n\x1a\n` (8 bytes)
  - Big Endian fields: `u16 message_version`, `u32 headers_start`, `u32 data_start`, then `u16 header_count`, then header KV strings, then body bytes.
  - Bridge parses and uses only the body (UTF-8 JSON string) for pairing requests.
  - Robustness: in practice some producers may emit the magic without the leading 0x89 (e.g., replaced with `EF BF BD`). The bridge searches for the `"BIN\r\n\x1a\n"` marker and computes absolute offsets accordingly.
- JSON envelope (fallback and for outbound from bridge):
  - Shape: `{ "data": "<string>", "headers": { ... } }` where `data` is a JSON string payload.
  - For `wc-sign-request-queue`: headers include `reply_to` and `correlation_id`.
  - For `wc-pairing-events`: headers include `correlation_id`.
- Inbound replies on `wc-sign-replies:<cid>`:
  - Supports BinaryMessageFormatV1 (preferred when replying via FastStream `return` from subscriber),
    JSON envelope fallback `{ data: "<string>", headers: {...} }`, and plain JSON.
  - Effective body after decode must be JSON: `{ "result": { ... } }` or `{ "error": "..." }`.

**Pairing Flow**
- Inbound: BLPOP from `wc-pairing-request`.
  - Body JSON: `{ "wc_uri": "<wc:..@2?...>", "address": "GB...", "user_info": { ... }? }`.
  - Bridge enqueues `{address,user_info}` to FIFO.
  - WalletKit pairs via `core.pairing.pair({ uri })`.
  - Emits event `queued` to `wc-pairing-events` including `address` and `user_info`.
- Session Proposal:
  - Validates presence of `stellar:pubnet` chain in required/optional namespaces.
  - Dequeues next `{address,user_info}`; if queue is empty but `pairingTopic` is provided, reuses the last bound `{address,user_info}` for this `pairingTopic` to allow “reconnect/return” flows without a new pairing request.
  - Approves with accounts formatted as `stellar:pubnet:<address>`.
  - Saves session context: `topic -> { address, user_info, dapp }`.
  - Caches binding: `pairingTopic -> { address, user_info }` (persisted in-memory; not removed on session delete since pairing remains alive).
  - Emits event `approved` (includes `client_id=topic`, `address`, `user_info`, `dapp_info`).
- Session Delete:
  - Removes session; emits `ended` with `client_id`, and where available `address`, `user_info`.
  - Pairing binding remains to support subsequent proposals over the same pairing (until pairing is explicitly removed/expired).

**Signing Flow**
- Inbound WC request: WalletKit `session_request` handler extracts `{ method, xdr }` and context `{ address, user_info, dapp }`.
- Outbound to broker: RPUSH to `wc-sign-request-queue` with JSON envelope:
  - headers: `{ reply_to: "wc-sign-replies:<cid>", correlation_id: "<cid>", content_type: "application/json", content_encoding: "utf-8" }`.
  - data: JSON string payload `{ request_id, wc_req_id, client_id, method, xdr, address, user_info, dapp_info, cid, replyTo }`.
- Waiting for reply: BLPOP from `wc-sign-replies:<cid>` with timeout (default 300s). Reply may arrive as BinaryMessageFormatV1, JSON envelope, or plain JSON — the bridge decodes all three.
  - On `{ error }`: respond to WC with JSON-RPC error (code 4001).
  - On `{ result }`: respond to WC with JSON-RPC result.

**Events (`wc-pairing-events`)**
- queued: `{ status: "queued", address, user_info, message }`.
- approved: `{ status: "approved", client_id, address, user_info, dapp_info, message }`.
- ended: `{ status: "ended", client_id, address?, user_info?, message }`.
- ready/failed (service lifecycle): `{ status: "ready"|"failed", ... }`.
- All events are wrapped in JSON envelope and RPUSH'ed to the list.

**Operational Notes**
- Timeouts: signing reply wait is 300s. On timeout, the bridge responds to WC with error 5000 and logs `RedisRPC.call.timeout`.
- Logging: verbose JSON logs with contexts; XDR is logged in full for debugging and can be reduced if needed.
- Reconnect UX: dApps that present a “Return” action after logout can reuse the same pairing; the bridge will auto-approve using the cached binding if no new pairing request arrives.

**Logging**
- Structured JSON logs to stdout: `{ ts, level, ctx, msg, data? }`.
- Key contexts: `Bridge.start`, `onPairingRequest`, `onSessionProposal`, `onSessionRequest`, `onSessionDelete`, `publishPairingEvent`, `consumePairingRequests`, `RedisRPC.call`, `parseFSMessageV1`.
- Sensitive data: XDR logged in full (by request); can be reduced if needed.

**Error Handling & Timeouts**
- Signing request timeout: 300s; on timeout, WC request responds with error 5000 and logs `RedisRPC.call.timeout`.
- Pairing decode errors: event `{ status: "failed", error }` is queued to `wc-pairing-events`.
- Robustness: separate Redis connections used for Pub/Sub (legacy), list pushes, and blocking BLPOP to avoid mode conflicts.

**Persistence**
- By default, WalletKit/Core state is in-memory. After restart, pairings/sessions are lost.
- Library supports external storage (IKeyValueStorage). To survive restarts:
  - Provide persistent storage for WalletKit/Core.
  - Persist `sessions[topic] -> { address, user_info, dapp }` in Redis and rehydrate on startup.

**Build & Run**
- Dockerfile: `Dockerfile.tsfs` builds Node 20 alpine, installs deps, runs via `npx tsx walletconnect-bridge.ts`.
- Commands:
  - Build: `docker build -t wc-bridge -f Dockerfile.tsfs .`
  - Run (Linux host): `docker run --rm --network host -e REDIS_URL=redis://127.0.0.1:6379/5 wc-bridge`
  - Override project id: `docker run --rm --network host -e REDIS_URL=redis://127.0.0.1:6379/5 -e WC_PROJECT_ID=your_project_id wc-bridge`

**Compatibility Notes**
- Reown WalletKit replaces `@walletconnect/web3wallet`; accounts must be `namespace:chainId:address` (e.g., `stellar:pubnet:GB...`).
- Required vs optional namespaces: proposal may put Stellar under `optionalNamespaces`; bridge handles both.
- `wc-pairing-request` and `wc-pairing-events` use Redis Lists; `wc-sign-request-queue` and `wc-sign-replies:<cid>` also use Lists.

**Examples**
- Pairing publish from FastStream (Python):
  - Use `broker.publish(msg, list="wc-pairing-request")` with BinaryMessageFormatV1.
  - `msg = { "wc_uri": "wc:...@2?...", "address": "GB...", "user_info": {...} }`.
- Pairing event consumption (Python):
  - Subscribe to `list="wc-pairing-events"`, parse envelope, then `json.loads(data)`.
- Signing handler (Python):
  - Consume from `list="wc-sign-request-queue"`, parse envelope, then `payload = json.loads(data)` → includes `reply_to` and `correlation_id`.
  - Reply options (both supported by the bridge):
    - Return from FastStream subscriber (with `message_format=BinaryMessageFormatV1`): `return {"result": {...}}` or `{"error": "..."}` — FastStream will encode to BinaryMessageFormatV1 and push into `reply_to` automatically.
    - Manual push: `RPUSH reply_to '{"result": { ... }}'` (or `'{"error": "..."}'`).

**Supported Methods**
- Stellar: `stellar_signXDR`, `stellar_signAndSubmitXDR`.
- Extendable: methods offered by dApp proposal are honored if present; otherwise defaults are used.

**Contact Points**
- For enabling persistent sessions, adding binary replies handling, or unifying all channels into Lists, extend the bridge as discussed.
