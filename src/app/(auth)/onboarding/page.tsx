export default function OnboardingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-6">
      <h1 className="text-2xl font-semibold">No clinic linked yet</h1>
      <p className="text-sm text-muted-foreground">
        Your account is not linked to a clinic. Ask the clinic owner to invite you, or create a new
        clinic.
      </p>
      <a className="text-sm underline" href="/signup">
        Create a clinic
      </a>
      <a className="text-sm underline" href="/login">
        Back to sign in
      </a>
    </main>
  );
}
