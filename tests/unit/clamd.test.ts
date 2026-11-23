// @vitest-environment node
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createClamdScanner, parseClamdReply } from "@/server/scanning/clamd";

const VERSION = "ClamAV 1.4.6/28184/Sun Nov 15 06:27:28 2026";
const servers: Server[] = [];
const sockets: Socket[] = [];

/**
 * A tiny clamd: reads "z<COMMAND>\0", for INSTREAM the length-prefixed chunks up to a zero length, then answers.
 * `delays` holds back the answer to one command (milliseconds).
 */
async function fakeClamd(answer: (command: string, payload: Buffer) => string | null, delays: Record<string, number> = {}) {
  const received: Buffer[] = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const payload: Buffer[] = [];
    socket.on("error", () => undefined);
    const reply = (name: string, body: Buffer) => {
      const text = answer(name, body);
      if (text === null) return;
      setTimeout(() => socket.end(`${text}\0`), delays[name] ?? 0);
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (command === null) {
        const end = buffer.indexOf(0);
        if (end === -1) return;
        command = buffer.subarray(1, end).toString("ascii");
        buffer = buffer.subarray(end + 1);
        if (command !== "INSTREAM") {
          reply(command, Buffer.alloc(0));
          return;
        }
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const all = Buffer.concat(payload);
          received.push(all);
          reply(command, all);
          buffer = Buffer.alloc(0);
          return;
        }
        if (buffer.length < 4 + size) return;
        payload.push(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, received };
}

const standard = (instream: string | null) => (command: string) =>
  command === "VERSION" ? VERSION : command === "PING" ? "PONG" : instream;

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe("parseClamdReply", () => {
  it.each([
    ["stream: OK\0", { kind: "clean" }],
    ["stream: Win.Test.EICAR_HDB-1 FOUND\0", { kind: "infected", signature: "Win.Test.EICAR_HDB-1" }],
    ["INSTREAM size limit exceeded. ERROR\0", { kind: "error", message: "INSTREAM size limit exceeded. ERROR" }],
    ["", { kind: "error", message: "" }],
  ])("reads %j", (reply, expected) => {
    expect(parseClamdReply(reply)).toEqual(expected);
  });

  it("never calls anything but the exact OK line clean", () => {
    expect(parseClamdReply("stream: OK and more").kind).toBe("error");
    expect(parseClamdReply("OK").kind).toBe("error");
  });
});

describe("createClamdScanner", () => {
  it("streams the bytes in length-prefixed chunks and reports clean with the engine version", async () => {
    const fake = await fakeClamd(standard("stream: OK"));
    const bytes = randomBytes(200_000);
    const outcome = await createClamdScanner({ host: "127.0.0.1", port: fake.port }).scan(bytes);
    expect(outcome).toEqual({ status: "clean", engine: VERSION });
    expect(Buffer.compare(fake.received[0], bytes)).toBe(0);
  });

  it("reports an infected file with the signature name", async () => {
    const fake = await fakeClamd(standard("stream: Win.Test.EICAR_HDB-1 FOUND"));
    expect(await createClamdScanner({ host: "127.0.0.1", port: fake.port }).scan(Buffer.from("x"))).toEqual({
      status: "infected",
      engine: VERSION,
      signature: "Win.Test.EICAR_HDB-1",
    });
  });

  it("treats an error reply, a silent scanner, a closed port, and an abort as unavailable (never clean)", async () => {
    const error = await fakeClamd(standard("INSTREAM size limit exceeded. ERROR"));
    expect((await createClamdScanner({ host: "127.0.0.1", port: error.port }).scan(Buffer.from("x"))).status).toBe("unavailable");

    const silent = await fakeClamd(standard(null));
    expect(await createClamdScanner({ host: "127.0.0.1", port: silent.port, timeoutMs: 400 }).scan(Buffer.from("x"))).toEqual({
      status: "unavailable",
      reason: "timeout",
    });

    const closed = await fakeClamd(standard("stream: OK"));
    await new Promise((resolve) => servers.pop()?.close(resolve));
    expect((await createClamdScanner({ host: "127.0.0.1", port: closed.port }).scan(Buffer.from("x"))).status).toBe("unavailable");

    const slow = await fakeClamd(standard(null));
    const controller = new AbortController();
    const pending = createClamdScanner({ host: "127.0.0.1", port: slow.port, timeoutMs: 5_000 }).scan(Buffer.from("x"), { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: "unavailable", reason: "aborted" });
  });

  it("refuses to call a file clean when the engine cannot name its version", async () => {
    const fake = await fakeClamd((command) => (command === "VERSION" ? null : "stream: OK"));
    expect((await createClamdScanner({ host: "127.0.0.1", port: fake.port, timeoutMs: 200 }).scan(Buffer.from("x"))).status).toBe("unavailable");
  });

  it("refuses a version reply that is not a ClamAV banner", async () => {
    const fake = await fakeClamd((command) => (command === "VERSION" ? "Something else" : "stream: OK"));
    expect(await createClamdScanner({ host: "127.0.0.1", port: fake.port }).scan(Buffer.from("x"))).toEqual({
      status: "unavailable",
      reason: "no engine version",
    });
  });

  it("shares ONE deadline between VERSION and INSTREAM (a slow VERSION leaves less time for the stream)", async () => {
    // VERSION answers after 250 ms, INSTREAM never. With separate deadlines this would take 250 + 400 ms.
    const fake = await fakeClamd(standard(null), { VERSION: 250 });
    const started = Date.now();
    const outcome = await createClamdScanner({ host: "127.0.0.1", port: fake.port, timeoutMs: 400 }).scan(Buffer.from("x"));
    const elapsed = Date.now() - started;
    expect(outcome).toEqual({ status: "unavailable", reason: "timeout" });
    expect(elapsed).toBeLessThan(550);
    expect(elapsed).toBeGreaterThanOrEqual(380);
  });

  it("refuses empty and oversized input without connecting", async () => {
    const scanner = createClamdScanner({ host: "127.0.0.1", port: 1 });
    expect(await scanner.scan(new Uint8Array(0))).toEqual({ status: "unavailable", reason: "empty" });
    expect(await scanner.scan(new Uint8Array(8 * 1024 * 1024 + 1))).toEqual({ status: "unavailable", reason: "too large" });
  });

  it("answers health from PING", async () => {
    const fake = await fakeClamd(standard("stream: OK"));
    expect(await createClamdScanner({ host: "127.0.0.1", port: fake.port }).health()).toEqual({ up: true, detail: "PONG" });
    expect((await createClamdScanner({ host: "127.0.0.1", port: 1, healthTimeoutMs: 200 }).health()).up).toBe(false);
  });
});
