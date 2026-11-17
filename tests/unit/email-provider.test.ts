// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createResendProvider, getEmailProvider, shareEmailMessage, type EmailMessage } from "@/server/messaging/email";

const MESSAGE: EmailMessage = { to: "asha@example.com", subject: "Your prescription", text: "t", html: "<p>h</p>" };

function recorder(respond: () => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond();
  };
  return { calls, impl };
}

describe("createResendProvider", () => {
  it("posts one JSON message to Resend with the API key and returns its id", async () => {
    const { calls, impl } = recorder(async () => Response.json({ id: "re_123" }));
    const outcome = await createResendProvider({ apiKey: "test-key", from: "ClinicPad <no-reply@clinicpad.test>", fetch: impl }).send(MESSAGE);
    expect(outcome).toEqual({ ok: true, providerMessageId: "re_123" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init?.method).toBe("POST");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ from: "ClinicPad <no-reply@clinicpad.test>", to: ["asha@example.com"], subject: "Your prescription", text: "t", html: "<p>h</p>" });
  });

  it.each([
    [422, "email_rejected"],
    [403, "email_rejected"],
    [429, "email_unavailable"],
    [500, "email_unavailable"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const { impl } = recorder(async () => new Response("{}", { status }));
    expect(await createResendProvider({ apiKey: "k", from: "a@b.test", fetch: impl }).send(MESSAGE)).toEqual({ ok: false, code });
  });

  it("maps a network error and a timeout, and tolerates a body that is not JSON", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const slow: typeof fetch = async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    };
    expect(await createResendProvider({ apiKey: "k", from: "a@b.test", fetch: down }).send(MESSAGE)).toEqual({ ok: false, code: "email_unavailable" });
    expect(await createResendProvider({ apiKey: "k", from: "a@b.test", fetch: slow }).send(MESSAGE)).toEqual({ ok: false, code: "email_timeout" });
    const { impl } = recorder(async () => new Response("ok", { status: 200 }));
    expect(await createResendProvider({ apiKey: "k", from: "a@b.test", fetch: impl }).send(MESSAGE)).toEqual({ ok: true, providerMessageId: null });
  });
});

describe("getEmailProvider", () => {
  it.each([
    [{}],
    [{ RESEND_API_KEY: "", EMAIL_FROM: "a@b.test" }],
    [{ RESEND_API_KEY: "k", EMAIL_FROM: "" }],
    [{ RESEND_API_KEY: "k", EMAIL_FROM: "no-at-sign" }],
    [{ RESEND_API_KEY: "k", EMAIL_FROM: "a@b.test\r\nBcc: x@y.test" }],
  ])("is null (email hidden) for %j", (env) => {
    expect(getEmailProvider(env)).toBeNull();
  });

  it("builds the Resend adapter only when both are set, without any network call", () => {
    expect(getEmailProvider({ RESEND_API_KEY: "k", EMAIL_FROM: "ClinicPad <no-reply@clinicpad.test>" })?.name).toBe("resend");
  });
});

describe("shareEmailMessage", () => {
  it("escapes the clinic name in HTML, keeps headers single-line, and carries the link but no patient data", () => {
    const m = shareEmailMessage({ to: "a@b.test", clinicName: 'Asha <b>Clinic</b>\r\nBcc: x', rxNo: 7, version: 1, url: "https://app.test/s/T", expiresOn: "24 Nov 2026", maxOpens: 10 });
    expect(m.subject).toBe("Your prescription from Asha <b>Clinic</b> Bcc: x");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).toContain("Asha &lt;b&gt;Clinic&lt;/b&gt;");
    expect(m.html).toContain('href="https://app.test/s/T"');
    expect(m.text).toContain("https://app.test/s/T");
    expect(m.text).toContain("10 times until 24 Nov 2026");
  });
});
