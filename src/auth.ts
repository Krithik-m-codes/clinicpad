import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "@/auth.config";
import { authenticateWithCredentials, getActiveMembership } from "@/server/auth/credentials";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: (raw) => authenticateWithCredentials(raw),
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        // When this sign-in happened (unix seconds). Unlike `iat`, which Auth.js renews every time it re-issues the cookie,
        // this never moves, so a re-invite of a temporary account can cut off every session from an earlier grant (ADR-0052).
        token.signedInAt = Math.floor(Date.now() / 1000);
      }
      // Re-read membership on every token use so role changes and deactivation
      // take effect immediately instead of when the JWT expires.
      if (token.sub) {
        const membership = await getActiveMembership(token.sub, typeof token.signedInAt === "number" ? token.signedInAt : 0);
        token.tenantId = membership?.tenantId ?? null;
        token.role = membership?.role ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.sub ?? "";
      session.user.tenantId = typeof token.tenantId === "string" ? token.tenantId : null;
      session.user.role = typeof token.role === "string" ? token.role : null;
      return session;
    },
  },
});
