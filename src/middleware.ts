import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export default NextAuth(authConfig).auth;

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/patients/:path*",
    "/prescriptions/:path*",
    "/settings/:path*",
    "/templates",
    // Everything under /templates except the upload endpoint: Next buffers a request body that passes through
    // middleware (up to 10 MB) before the handler runs, so the handler authenticates itself and caps the stream.
    "/templates/((?!uploads$).+)",
  ],
};
