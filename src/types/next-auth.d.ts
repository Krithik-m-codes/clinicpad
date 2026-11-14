import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    tenantId?: string | null;
    role?: string | null;
  }
  interface Session {
    user: {
      id: string;
      tenantId: string | null;
      role: string | null;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    tenantId?: string | null;
    role?: string | null;
  }
}
