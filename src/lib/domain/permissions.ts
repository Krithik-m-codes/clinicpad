const MATRIX = {
  "patient.read": ["owner", "doctor", "reception", "nurse"],
  "patient.write": ["owner", "doctor", "reception"],
  "patient.archive": ["owner"],
  "rx.read": ["owner", "doctor", "reception", "nurse", "pharmacist"],
  "rx.draft": ["owner", "doctor"],
  "rx.finalize": ["owner", "doctor"],
  "rx.amend": ["owner", "doctor"],
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
