// npm i -E typescript ts-node @walletconnect/core @walletconnect/web3wallet @walletconnect/types uuid redis
// npx ts-node walletconnect-bridge.ts

import { createClient, RedisClientType } from "redis";
import { Core } from "@walletconnect/core";
import { WalletKit } from "@reown/walletkit";
import type { SessionTypes, SignClientTypes } from "@walletconnect/types";
import { v4 as uuidv4 } from "uuid";

// Simple structured logger
const log = (
  level: "debug" | "info" | "warn" | "error",
  ctx: string,
  msg: string,
  data?: Record<string, unknown>
) => {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    ctx,
    msg,
  };
  if (data !== undefined) entry.data = data;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
};

const WC_PROJECT_ID = process.env.WC_PROJECT_ID || "000";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Каналы совместимые по смыслу с Python-версией
const CH_PAIRING_REQUEST = "wc-pairing-request";     // { wc_uri, address, user_info? }
const CH_PAIRING_EVENTS  = "wc-pairing-events";      // статусы pairing/session
const CH_SIGN_REQUEST    = "wc-sign-request-queue";  // RPC-запросы на подпись

// Очередь адресов для auto-approve (FIFO) — если нужно параллелить, сделай мапу по correlation
const addressQueue: Array<{address: string; user_info?: Record<string, unknown>}> = [];

class RedisRPC {
  private pub: RedisClientType;
  private blk: RedisClientType;
  private sub: RedisClientType;
  private waiters: Map<string, (msg: any) => void> = new Map();

  constructor(pub: RedisClientType, blk: RedisClientType, sub: RedisClientType) {
    this.pub = pub;
    this.blk = blk;
    this.sub = sub;
    log("debug", "RedisRPC", "constructor", { hasPub: !!pub, hasBlk: !!blk, hasSub: !!sub });
  }

  async call(request: any, timeoutMs = 300_000): Promise<any> {
    log("debug", "RedisRPC.call", "enter", { timeoutMs });
    const cid = uuidv4();
    const replyTo = `wc-sign-replies:${cid}`;
    const inner = { ...request, cid, replyTo };
    const envelope = {
      data: JSON.stringify(inner),
      headers: {
        reply_to: replyTo,
        correlation_id: cid,
        content_type: "application/json",
        content_encoding: "utf-8",
      },
    };
    const payload = JSON.stringify(envelope);
    log("debug", "RedisRPC.call", "prepared", { cid, replyTo, envelope });

    // Push request to a Redis List and wait for reply via BLPOP on a reply list
    const pushLen = await this.pub.rPush(CH_SIGN_REQUEST, payload);
    log("info", "RedisRPC.call", "queued_rpush", { list: CH_SIGN_REQUEST, length: pushLen, cid });

    const deadline = Date.now() + timeoutMs;
    let resolved = false;
    let result: any | undefined;

    // Parser shared by both paths
    const parseFS = (buf: Buffer | string): string => {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as string);
      try {
        const marker = Buffer.from([0x42, 0x49, 0x4e, 0x0d, 0x0a, 0x1a, 0x0a]);
        const j = b.indexOf(marker, 0);
        if (j >= 0 && b.length >= j + 17) {
          const msgStart = Math.max(0, j - 1);
          const ver = b.readUInt16BE(j + 7);
          const dataStart = b.readUInt32BE(j + 13);
          const absDataStart = msgStart + dataStart;
          log("debug", "RedisRPC.call", "fs.binary.detected", { j, msgStart, ver, dataStart, absDataStart, len: b.length });
          if (ver === 1 && absDataStart > 0 && absDataStart <= b.length) {
            return b.subarray(absDataStart).toString("utf8");
          }
        }
      } catch {}
      try {
        const env = JSON.parse(b.toString("utf8"));
        if (env && typeof env.data === "string") return env.data;
      } catch {}
      return b.toString("utf8");
    };

    // Subscribe to Pub/Sub channel for reply (compat with FastStream return)
    await this.sub.subscribe(replyTo, (message: string) => {
      if (resolved) return;
      try {
        const body = parseFS(message);
        log("debug", "RedisRPC.call", "psub.body", { body });
        const msg = JSON.parse(body);
        resolved = true;
        result = msg;
      } catch (e) {
        log("error", "RedisRPC.call", "psub.parse_error", { cid, error: String(e) });
      }
    });
    log("info", "RedisRPC.call", "subscribed", { channel: replyTo });

    // Poll BLPOP in short intervals to allow early Pub/Sub resolution
    while (!resolved && Date.now() < deadline) {
      const remainMs = Math.max(0, deadline - Date.now());
      const tickSec = Math.max(1, Math.min(5, Math.ceil(remainMs / 1000)));
      const replyRaw: any = await (this.blk as any).sendCommand([
        "BLPOP",
        replyTo,
        String(tickSec),
      ], { returnBuffers: true } as any);
      if (replyRaw && !resolved) {
        const keyBuf: Buffer = replyRaw[0];
        const raw: Buffer = replyRaw[1];
        log("debug", "RedisRPC.call", "blpop.reply", { key: keyBuf.toString(), size: raw.length });
        try {
          const body = parseFS(raw);
          log("debug", "RedisRPC.call", "reply.body", { body });
          result = JSON.parse(body);
          resolved = true;
          break;
        } catch (e) {
          log("error", "RedisRPC.call", "parse_error", { cid, error: String(e) });
          // continue polling until timeout
        }
      }
    }

    // Cleanup subscription
    try { await this.sub.unsubscribe(replyTo); } catch {}

    if (!resolved) {
      log("error", "RedisRPC.call", "timeout", { cid, replyTo });
      throw new Error("sign timeout");
    }
    log("info", "RedisRPC.call", "resolve", { cid });
    return result;
  }
}

class Bridge {
  private core!: any;
  private wallet!: any;
  private redisPub!: RedisClientType;
  private redisSub!: RedisClientType;
  private redisBlk!: RedisClientType;
  private redisPair!: RedisClientType;
  private rpc!: RedisRPC;

  private sessions = new Map<string, { address: string; user_info?: Record<string, unknown>; dapp?: { name?: string; url?: string } }>();
  private pairingBindings = new Map<string, { address: string; user_info?: Record<string, unknown> }>();

  async start() {
    log("info", "Bridge.start", "enter", { REDIS_URL });
    this.redisPub = createClient({ url: REDIS_URL });
    this.redisSub = createClient({ url: REDIS_URL });
    this.redisBlk = createClient({ url: REDIS_URL });
    this.redisPair = createClient({ url: REDIS_URL });
    this.redisPub.on("error", (e) => log("error", "redisPub", "error", { error: String(e) }));
    this.redisSub.on("error", (e) => log("error", "redisSub", "error", { error: String(e) }));
    this.redisBlk.on("error", (e) => log("error", "redisBlk", "error", { error: String(e) }));
    this.redisPair.on("error", (e) => log("error", "redisPair", "error", { error: String(e) }));
    await this.redisPub.connect();
    log("info", "Bridge.start", "redisPub.connected");
    await this.redisSub.connect();
    log("info", "Bridge.start", "redisSub.connected");
    await this.redisBlk.connect();
    log("info", "Bridge.start", "redisBlk.connected");
    await this.redisPair.connect();
    log("info", "Bridge.start", "redisPair.connected");

    this.rpc = new RedisRPC(this.redisPub, this.redisBlk, this.redisSub);
    log("debug", "Bridge.start", "rpc.created");

    this.core = new Core({ projectId: WC_PROJECT_ID });
    log("info", "Bridge.start", "core.init", { projectId: WC_PROJECT_ID });
    this.wallet = await WalletKit.init({
      core: this.core,
      metadata: {
        name: "MMWB Wallet",
        description: "A wallet that delegates signing to a broker.",
        url: "https://eurmtl.me",
        icons: ["https://eurmtl.me/static/icons/android-chrome-192x192.png"],
      },
    });
    log("info", "Bridge.start", "wallet.init.done");

    // Start consumer loop for pairing requests list
    this.consumePairingRequests().catch((e) => log("error", "consumePairingRequests", "fatal", { error: String(e) }));
    log("info", "Bridge.start", "pairing.consumer.started", { list: CH_PAIRING_REQUEST });

    // Wrap async handlers to prevent unhandled rejections from crashing the process
    const wrap = <T>(label: string, fn: (arg: T) => Promise<void>) => async (arg: T) => {
      try {
        await fn.call(this, arg);
      } catch (e) {
        log("error", label, "handler_exception", { error: String(e) });
      }
    };

    this.wallet.on("session_proposal", wrap("session_proposal", this.onSessionProposal));
    this.wallet.on("session_request", wrap("session_request", this.onSessionRequest));
    this.wallet.on("session_delete", wrap("session_delete", this.onSessionDelete));
    log("info", "Bridge.start", "wallet.handlers.bound");

    await this.publishPairingEvent({ status: "ready", message: "WalletConnect bridge is ready" });
    log("info", "Bridge.start", "exit");
  }

  private publishPairingEvent = async (evt: any) => {
    log("debug", "publishPairingEvent", "enter", { evt });
    const envelope = {
      data: JSON.stringify(evt),
      headers: {
        correlation_id: uuidv4(),
        content_type: "application/json",
        content_encoding: "utf-8",
      },
    };
    const len = await this.redisPub.rPush(CH_PAIRING_EVENTS, JSON.stringify(envelope));
    log("info", "publishPairingEvent", "queued_rpush", { list: CH_PAIRING_EVENTS, length: len });
    log("debug", "publishPairingEvent", "exit");
  };

  private parseFSMessageV1 = (buf: Buffer | string): { body: string; headers?: Record<string, string> } => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as string);
    try {
      // Look for "BIN\r\n\x1a\n" marker (7 bytes) anywhere near the start.
      const marker = Buffer.from([0x42, 0x49, 0x4e, 0x0d, 0x0a, 0x1a, 0x0a]);
      const j = b.indexOf(marker, 0);
      const headHex = b.subarray(0, Math.min(24, b.length)).toString("hex");
      if (j >= 0 && b.length >= j + 17) {
        const msgStart = Math.max(0, j - 1); // expected position of 0x89 before "BIN"
        // Version immediately follows marker (BE u16)
        const ver = b.readUInt16BE(j + 7);
        const headersStart = b.readUInt32BE(j + 9);
        const dataStart = b.readUInt32BE(j + 13);
        const absDataStart = msgStart + dataStart;
        log("debug", "parseFSMessageV1", "binary.detected", { j, msgStart, ver, headersStart, dataStart, absDataStart, len: b.length, headHex });
        if (ver === 1 && absDataStart > 0 && absDataStart <= b.length) {
          const body = b.subarray(absDataStart).toString("utf8");
          return { body };
        }
      } else {
        log("debug", "parseFSMessageV1", "binary.header_mismatch", { headHex, len: b.length });
      }
    } catch (e) {
      log("warn", "parseFSMessageV1", "binary_parse_failed", { error: String(e) });
    }
    // JSON envelope fallback: { data: string, headers: {...} }
    try {
      const s = b.toString("utf8");
      const env = JSON.parse(s);
      if (env && typeof env.data === "string") {
        return { body: env.data, headers: env.headers };
      }
    } catch (e) {
      log("debug", "parseFSMessageV1", "json_fallback_failed", { error: String(e) });
    }
    // Raw fallback
    const body = b.toString("utf8");
    return { body };
  };

  private async consumePairingRequests() {
    log("info", "consumePairingRequests", "enter", { list: CH_PAIRING_REQUEST });
    while (true) {
      try {
        const reply: any = await (this.redisPair as any).sendCommand([
          "BLPOP",
          CH_PAIRING_REQUEST,
          "0",
        ], { returnBuffers: true } as any);
        if (!reply) continue;
        const keyBuf: Buffer = reply[0];
        const raw: Buffer = reply[1];
        log("debug", "consumePairingRequests", "blpop", { key: keyBuf.toString(), size: raw.length });
        const { body } = this.parseFSMessageV1(raw);
        log("debug", "consumePairingRequests", "decoded", { body });
        await this.onPairingRequest(body);
      } catch (e) {
        log("error", "consumePairingRequests", "loop_error", { error: String(e) });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private onPairingRequest = async (payload: string) => {
    log("info", "onPairingRequest", "enter", { payload });
    try {
      const msg = JSON.parse(payload);
      log("debug", "onPairingRequest", "parsed", { msg });
      const wc_uri: string | undefined = msg?.wc_uri;
      const address: string | undefined = msg?.address;
      const user_info = msg?.user_info;
      log("debug", "onPairingRequest", "extracted", { wc_uri, address, has_user_info: !!user_info });
      if (!wc_uri || !address) return;

      addressQueue.push({ address, user_info });
      log("info", "onPairingRequest", "queued", { queueLength: addressQueue.length });
      await this.core.pairing.pair({ uri: wc_uri });
      log("info", "onPairingRequest", "paired", { wc_uri });

      await this.publishPairingEvent({
        status: "queued",
        address,
        user_info,
        message: "Pairing request received",
      });
      log("info", "onPairingRequest", "exit.success");
    } catch (e) {
      log("error", "onPairingRequest", "exception", { error: String(e) });
      await this.publishPairingEvent({ status: "failed", error: String(e) });
    }
  };

  private onSessionProposal = async (proposal: SignClientTypes.EventArguments["session_proposal"]) => {
    try {
      log("info", "onSessionProposal", "enter", { id: proposal.id });
      const { id, params } = proposal;
      const required = params.requiredNamespaces || {};
      const optional = (params as any).optionalNamespaces || {};
      const meta = params.proposer?.metadata || {};
      const pairingTopic: string | undefined = (params as any).pairingTopic;
      log("debug", "onSessionProposal", "pairingTopic", { pairingTopic });
    log("debug", "onSessionProposal", "params", { required, optional, meta });

    // Prefer 'stellar' namespace from required, fallback to optional
      const stellarNs = (required.stellar ?? optional.stellar) as any;
      const chains: string[] = Array.from(new Set((stellarNs?.chains || []).map((c: string) => c)));
      log("debug", "onSessionProposal", "chains", { chains });

      if (!chains.some((c) => c === "stellar:pubnet" || c === "pubnet")) {
        log("warn", "onSessionProposal", "reject.missing_pubnet", { id, chains });
        await this.wallet.rejectSession({ id, reason: { code: 4000, message: "Required chain pubnet missing" } });
        log("info", "onSessionProposal", "exit.reject");
        return;
      }

      const next = addressQueue.shift();
      let address = next?.address as string | undefined;
      let user_info = next?.user_info as Record<string, unknown> | undefined;
      log("debug", "onSessionProposal", "dequeue", { address, has_user_info: !!user_info, queueLength: addressQueue.length });

    // Fallback: reuse binding from same pairing topic (session re-connect without new pairing request)
    if (!address && pairingTopic && this.pairingBindings.has(pairingTopic)) {
      const bind = this.pairingBindings.get(pairingTopic)!;
      address = bind.address;
      user_info = bind.user_info;
      log("info", "onSessionProposal", "reuse.pairingBinding", { pairingTopic, address, has_user_info: !!user_info });
    }

      if (!address) {
        log("warn", "onSessionProposal", "reject.no_address", { id });
        await this.wallet.rejectSession({ id, reason: { code: 4001, message: "No address bound for proposal" } });
        log("info", "onSessionProposal", "exit.reject");
        return;
      }

      const accounts = chains
        .filter((c) => c === "stellar:pubnet" || c === "pubnet")
        .map((c) => (c.includes(":") ? `${c}:${address}` : `stellar:${c}:${address}`));

      const methods: string[] =
        (stellarNs?.methods && Array.isArray(stellarNs.methods) && stellarNs.methods.length > 0)
          ? stellarNs.methods
          : ["stellar_signXDR", "stellar_signAndSubmitXDR"];
      const events: string[] = Array.isArray(stellarNs?.events) ? stellarNs.events : [];
      log("debug", "onSessionProposal", "ns.build", { accounts, methods, events });

      const namespaces: SessionTypes.Namespaces = {
        stellar: {
          accounts,
          methods,
          events,
        },
      };

      const { topic } = await this.wallet.approveSession({ id, namespaces });
      log("info", "onSessionProposal", "approved", { topic });
      this.sessions.set(topic, { address, user_info, dapp: { name: meta.name, url: meta.url } });
      log("debug", "onSessionProposal", "session.store", { topic, address, dapp: { name: meta.name, url: meta.url } });

    // Bind address to pairing topic for future proposals over same pairing
      if (pairingTopic) {
        this.pairingBindings.set(pairingTopic, { address, user_info });
        log("debug", "onSessionProposal", "pairing.bind", { pairingTopic, address, has_user_info: !!user_info });
      }

      await this.publishPairingEvent({
        status: "approved",
        client_id: topic,
        address,
        dapp_info: { name: meta.name, url: meta.url },
        user_info,
        message: "Connected to dApp",
      });
      log("info", "onSessionProposal", "exit.success");
    } catch (e) {
      log("error", "onSessionProposal", "exception", { error: String(e) });
      try {
        await this.publishPairingEvent({ status: "failed", error: String(e) });
      } catch {}
    }
  };

  private onSessionDelete = async (args: SignClientTypes.EventArguments["session_delete"]) => {
    log("info", "onSessionDelete", "enter", { topic: args.topic });
    const { topic } = args;
    const info = this.sessions.get(topic);
    const address = info?.address;
    const user_info = info?.user_info;
    this.sessions.delete(topic);
    log("debug", "onSessionDelete", "session.deleted", { topic });
    await this.publishPairingEvent({
      status: "ended",
      client_id: topic,
      address,
      user_info,
      message: "Session ended; pairing kept alive",
    });
    log("info", "onSessionDelete", "exit");
  };

  private onSessionRequest = async (event: SignClientTypes.EventArguments["session_request"]) => {
    log("info", "onSessionRequest", "enter", { topic: event.topic, id: event.id });
    const { id, topic, params } = event;
    const { request } = params;
    const info = this.sessions.get(topic);
    const address = info?.address as string | undefined;
    log("debug", "onSessionRequest", "context", { address, has_user_info: !!info?.user_info });

    try {
      const method = request.method;
      const p = request.params as any;
      const xdr = p?.xdr ?? (Array.isArray(p) && p[0]?.xdr);
      log("debug", "onSessionRequest", "extracted", { method, has_xdr: !!xdr });
      log("debug", "onSessionRequest", "xdr.payload", { xdr });
      if (!address || !xdr) {
        log("warn", "onSessionRequest", "bad_params", { addressPresent: !!address, has_xdr: !!xdr });
        await this.wallet.respondSessionRequest({
          topic,
          response: {
            id,
            jsonrpc: "2.0",
            error: { code: 4000, message: "Bad params" },
          },
        });
        log("info", "onSessionRequest", "exit.bad_params");
        return;
      }

      const reqPayload = {
        request_id: uuidv4(),
        wc_req_id: id,
        client_id: topic,
        method,
        xdr,
        address,
        user_info: info?.user_info,
        dapp_info: info?.dapp,
      };
      log("debug", "onSessionRequest", "rpc.call", { reqPayload });

      const reply = await this.rpc.call(reqPayload, 300_000);
      log("debug", "onSessionRequest", "rpc.reply", { reply });
      if (reply?.error) {
        log("warn", "onSessionRequest", "rpc.error", { error: reply.error });
        await this.wallet.respondSessionRequest({
          topic,
          response: {
            id,
            jsonrpc: "2.0",
            error: { code: 4001, message: String(reply.error) },
          },
        });
        log("info", "onSessionRequest", "exit.rpc_error");
        return;
      }

      const result = reply?.result || {};
      log("debug", "onSessionRequest", "respond.result", { result });
      await this.wallet.respondSessionRequest({
        topic,
        response: {
          id,
          jsonrpc: "2.0",
          result,
        },
      });
      log("info", "onSessionRequest", "exit.success");
    } catch (e) {
      log("error", "onSessionRequest", "exception", { error: String(e) });
      await this.wallet.respondSessionRequest({
        topic,
        response: {
          id,
          jsonrpc: "2.0",
          error: { code: 5000, message: String(e) },
        },
      });
      log("info", "onSessionRequest", "exit.exception");
    }
  };
}

(async () => {
  const b = new Bridge();
  log("info", "main", "starting");
  // Global safety nets to avoid process crash
  process.on("uncaughtException", (err) => {
    try { log("error", "process", "uncaughtException", { error: String(err), stack: (err as any)?.stack }); } catch {}
  });
  process.on("unhandledRejection", (reason) => {
    try { log("error", "process", "unhandledRejection", { reason: String(reason) }); } catch {}
  });

  await b.start();
  // eslint-disable-next-line no-console
  console.log("FastStream-less Node bridge started. Channels:", {
    CH_PAIRING_REQUEST,
    CH_PAIRING_EVENTS,
    CH_SIGN_REQUEST,
  });
  log("info", "main", "started");
})();
