import { connect, type Socket } from "node:net";
import { SCAN_LIMITS, type MalwareScanner, type ScanOutcome } from "./scanner";

export type ClamdOptions = { host: string; port: number; timeoutMs?: number; healthTimeoutMs?: number };

type Reply = { kind: "clean" } | { kind: "infected"; signature: string } | { kind: "error"; message: string };

/**
 * clamd answers z-commands with NUL-terminated text: "stream: OK", "stream: <signature> FOUND", or "<message> ERROR"
 * (the size-limit error has no "stream:" prefix). Only the exact OK line is clean.
 */
export function parseClamdReply(reply: string): Reply {
  const text = reply.replace(/\0+$/, "").trim();
  if (text === "stream: OK") return { kind: "clean" };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { kind: "infected", signature: found[1].slice(0, 200) };
  return { kind: "error", message: text.slice(0, 200) };
}

type Talk = { ok: true; reply: string } | { ok: false; reason: string };

/**
 * One TCP exchange: send, read one NUL-terminated reply (at most 4 KB) before the ABSOLUTE `deadline` (epoch ms).
 * Never throws; always destroys the socket.
 */
function talk(opts: ClamdOptions, deadline: number, send: (socket: Socket) => void, signal?: AbortSignal): Promise<Talk> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: "aborted" });
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      resolve({ ok: false, reason: "timeout" });
      return;
    }
    const socket = connect({ host: opts.host, port: opts.port });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Talk) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(value);
    };
    const onAbort = () => finish({ ok: false, reason: "aborted" });
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), remaining);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("error", () => finish({ ok: false, reason: "unreachable" }));
    socket.on("connect", () => send(socket));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > SCAN_LIMITS.maxReplyBytes) return finish({ ok: false, reason: "reply too long" });
      chunks.push(chunk);
      if (chunk.includes(0)) finish({ ok: true, reply: Buffer.concat(chunks).toString("utf8") });
    });
    socket.on("end", () => finish(chunks.length > 0 ? { ok: true, reply: Buffer.concat(chunks).toString("utf8") } : { ok: false, reason: "closed" }));
  });
}

/**
 * Scanner backed by clamd's INSTREAM command (ADR-0046). The engine string recorded with every stored file is clamd's
 * VERSION reply (engine/signature database/date), cached for ten minutes; without it a file is never called clean.
 * VERSION and INSTREAM of one scan share a single deadline of `timeoutMs`.
 */
export function createClamdScanner(opts: ClamdOptions): MalwareScanner {
  const timeoutMs = opts.timeoutMs ?? SCAN_LIMITS.timeoutMs;
  let version: { text: string; at: number } | null = null;

  async function engine(deadline: number, signal?: AbortSignal): Promise<string | null> {
    if (version && Date.now() - version.at < SCAN_LIMITS.versionCacheMs) return version.text;
    const result = await talk(opts, deadline, (s) => s.end("zVERSION\0"), signal);
    const text = result.ok ? result.reply.replace(/\0+$/, "").trim().slice(0, 200) : "";
    if (!/^ClamAV \S+/.test(text)) return null;
    version = { text, at: Date.now() };
    return text;
  }

  return {
    async scan(bytes, scanOpts = {}): Promise<ScanOutcome> {
      if (bytes.length === 0) return { status: "unavailable", reason: "empty" };
      if (bytes.length > SCAN_LIMITS.maxBytes) return { status: "unavailable", reason: "too large" };
      const deadline = Date.now() + timeoutMs;
      const name = await engine(deadline, scanOpts.signal);
      if (name === null) {
        if (scanOpts.signal?.aborted) return { status: "unavailable", reason: "aborted" };
        return { status: "unavailable", reason: Date.now() >= deadline ? "timeout" : "no engine version" };
      }
      const result = await talk(
        opts,
        deadline,
        (socket) => {
          socket.write("zINSTREAM\0");
          for (let at = 0; at < bytes.length; at += SCAN_LIMITS.chunkBytes) {
            const part = bytes.subarray(at, Math.min(bytes.length, at + SCAN_LIMITS.chunkBytes));
            const head = Buffer.alloc(4);
            head.writeUInt32BE(part.length);
            socket.write(head);
            socket.write(part);
          }
          socket.write(Buffer.alloc(4)); // a zero-length chunk ends the stream
        },
        scanOpts.signal,
      );
      if (!result.ok) return { status: "unavailable", reason: result.reason };
      const reply = parseClamdReply(result.reply);
      if (reply.kind === "clean") return { status: "clean", engine: name };
      if (reply.kind === "infected") return { status: "infected", engine: name, signature: reply.signature };
      return { status: "unavailable", reason: reply.message };
    },
    async health() {
      const result = await talk(opts, Date.now() + (opts.healthTimeoutMs ?? SCAN_LIMITS.healthTimeoutMs), (s) => s.end("zPING\0"));
      const text = result.ok ? result.reply.replace(/\0+$/, "").trim() : "";
      return text === "PONG" ? { up: true, detail: "PONG" } : { up: false, detail: result.ok ? "unexpected reply" : result.reason };
    },
  };
}
