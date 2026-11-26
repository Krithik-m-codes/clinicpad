const MATRIX = {
  "patient.read": ["owner", "doctor", "reception", "nurse"],
  "patient.write": ["owner", "doctor", "reception"],
  "patient.archive": ["owner"],
  "patient.import": ["owner"],
  "rx.read": ["owner", "doctor", "reception", "nurse", "pharmacist"],
  "rx.draft": ["owner", "doctor"],
  "rx.finalize": ["owner", "doctor"],
  "rx.amend": ["owner", "doctor"],
  "consent.capture": ["owner", "doctor", "reception"],
  "rx.share": ["owner", "doctor", "reception"],
  "catalogue.read": ["owner", "doctor", "nurse", "pharmacist"],
  "catalogue.write": ["owner", "doctor"],
  "settings.clinic": ["owner"],
  "settings.profile": ["owner", "doctor"],
  // Plan 2A Template Studio. Doctors write and assign only within their own profile; designers never touch patients (checked in the services).
  "template.read": ["owner", "doctor", "designer"],
  "template.write": ["owner", "doctor", "designer"],
  "template.publish": ["owner"],
  "template.assign": ["owner", "doctor"],
  // Plan 2C: invite, extend and revoke the temporary designer account (ADR-0052). Owner only.
  "designer.manage": ["owner"],
} as const satisfies Record<string, readonly string[]>;

export type Action = keyof typeof MATRIX;

/**
 * Server-side authorization. UI hiding is convenience only; every service and server
 * action must call this (design spec §4). Unknown roles and unknown actions are denied.
 */
export function can(role: string | null | undefined, action: Action): boolean {
  if (!role) return false;
  if (!Object.hasOwn(MATRIX, action)) return false;
  return (MATRIX[action] as readonly string[]).includes(role);
}
