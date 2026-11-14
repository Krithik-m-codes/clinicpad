import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe config shared by middleware. It must not import the database or bcrypt.
 * The full config (with the credentials provider and DB-backed callbacks) is in auth.ts.
 */
export const authConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    authorized({ auth }) {
      return Boolean(auth?.user);
    },
  },
} satisfies NextAuthConfig;
