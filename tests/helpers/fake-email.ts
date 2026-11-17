import type { EmailFailureCode, EmailMessage, EmailProvider } from "@/server/messaging/email";

export type FakeEmailProvider = EmailProvider & { sent: EmailMessage[]; failWith: EmailFailureCode | null };

/** Records what would have been sent; never touches the network. */
export function createFakeEmailProvider(): FakeEmailProvider {
  const provider: FakeEmailProvider = {
    name: "fake",
    sent: [],
    failWith: null,
    async send(message) {
      provider.sent.push(message);
      return provider.failWith ? { ok: false, code: provider.failWith } : { ok: true, providerMessageId: `fake-${provider.sent.length}` };
    },
  };
  return provider;
}
