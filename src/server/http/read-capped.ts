/**
 * Reads a body while counting bytes; stops reading (and cancels the stream) once `maxBytes` is exceeded, so a client
 * or a service can never make the handler buffer more than the cap (plus the one chunk that crossed it). A missing
 * body reads as empty.
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<ArrayBuffer | "too_large"> {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  const buffer = new ArrayBuffer(total);
  const out = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}
