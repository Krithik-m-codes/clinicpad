type Props = {
  allergies: readonly string[] | null | undefined;
  /** Show a muted "none recorded" line when the list is empty (the prescription screen does). */
  showWhenEmpty?: boolean;
};

/** The patient's recorded allergies, shown wherever a clinician is about to prescribe or review. */
export function AllergyBanner({ allergies, showWhenEmpty = false }: Props) {
  if (allergies?.length) {
    return (
      <p className="mt-2 inline-block rounded bg-red-50 px-2 py-1 text-sm text-red-800">
        Allergies: {allergies.join(", ")}
      </p>
    );
  }
  return showWhenEmpty ? <p className="mt-2 text-sm text-muted-foreground">No known allergies recorded</p> : null;
}
