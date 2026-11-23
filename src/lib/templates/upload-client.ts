export type UploadResult = { ok: true; fileId: string } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sends the processed pad image to the upload route (the bytes only: no file name, no declared type). Every failure is a friendly sentence. Browser only. */
export async function uploadBackground(blob: Blob): Promise<UploadResult> {
  try {
    const response = await fetch("/templates/uploads", { method: "POST", body: blob, headers: { "Content-Type": "application/octet-stream" }, credentials: "same-origin" });
    const body = (await response.json().catch(() => ({}))) as { fileId?: unknown; message?: unknown };
    if (response.ok && typeof body.fileId === "string" && UUID.test(body.fileId)) return { ok: true, fileId: body.fileId };
    if (response.status === 401) return { ok: false, message: "Your session ended. Sign in again, then upload the pad." };
    const message = typeof body.message === "string" && body.message.length > 0 && body.message.length < 300 ? body.message : null;
    return { ok: false, message: message ?? "The pad image could not be uploaded. Try again." };
  } catch {
    return { ok: false, message: "The pad image could not be uploaded. Check the connection and try again." };
  }
}
