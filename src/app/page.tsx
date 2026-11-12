import { redirect } from "next/navigation";

// Middleware sends unauthenticated visitors from /dashboard to /login.
export default function HomePage() {
  redirect("/dashboard");
}
