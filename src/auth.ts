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
      if (user) token.sub = user.id;
      // Re-read membership on every token use so role changes and deactivation
      // take effect immediately instead of when the JWT expires.
      if (token.sub) {
        const membership = await getActiveMembership(token.sub);
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
