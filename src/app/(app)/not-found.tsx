import Link from "next/link";

/** Shown for notFound() inside the app: unknown, foreign, and forbidden records all look the same. */
export default function AppNotFound() {
  return (
    <div className="max-w-md space-y-3 rounded-lg border p-6">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="text-sm text-muted-foreground">
        This page or record could not be found, or your role cannot open it.
      </p>
      <Link className="text-sm underline" href="/dashboard">
        Go to the dashboard
      </Link>
    </div>
  );
}
