const MESSAGES: Record<string, string> = {
  forbidden: "You do not have permission to do that.",
  not_found: "That record could not be found.",
  invalid: "That could not be done with the current details.",
  conflict: "That cannot be done right now; the record has changed.",
  immutable: "That record is finalized and cannot be changed.",
};

/** Shows the outcome of a failed server action that redirected back with `?error=<code>`. Unknown codes show nothing. */
export function RedirectError({ code }: { code: string | undefined }) {
  const message = code && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : null;
  if (!message) return null;
  return (
    <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  );
}
