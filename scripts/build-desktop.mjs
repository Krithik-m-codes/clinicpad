// Static export for the Tauri desktop shell.
//
// Until Phase 4 (offline-first desktop with local SQLite + sync) the desktop app is the
// legacy offline prescription generator only. Routes that need a server (auth, tenant
// dashboard, API handlers that touch Postgres, middleware) cannot be part of a static
// export, so they are moved aside for the duration of the build and always restored.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stashDir = join(root, ".desktop-stash");

// Paths relative to the repo root. Order does not matter; each is moved as a unit.
const SERVER_ONLY = [
  "src/app/(app)",
  "src/app/(auth)",
  "src/app/api/auth",
  "src/app/api/health",
  "src/app/api/catalogue",
  "src/app/api/clean-data",
  "src/app/s", // public share links (server only)
  "src/app/page.tsx", // server redirect to /dashboard; replaced below
  "src/middleware.ts",
];

const DESKTOP_HOME = `"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function DesktopHome() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/prescribe");
  }, [router]);
  return null;
}
`;

function stashPath(rel) {
  return join(stashDir, rel.replaceAll("/", "__"));
}

function restore() {
  if (!existsSync(stashDir)) return;
  for (const rel of SERVER_ONLY) {
    const stashed = stashPath(rel);
    const original = join(root, rel);
    if (!existsSync(stashed)) continue;
    if (existsSync(original)) rmSync(original, { recursive: true, force: true });
    renameSync(stashed, original);
  }
  if (readdirSync(stashDir).length === 0) rmSync(stashDir, { recursive: true, force: true });
}

// A previous run may have been killed before it could restore.
restore();

let restored = false;
function restoreOnce() {
  if (restored) return;
  restored = true;
  restore();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restoreOnce();
    process.exit(130);
  });
}

let status = 1;
try {
  mkdirSync(stashDir, { recursive: true });
  for (const rel of SERVER_ONLY) {
    const original = join(root, rel);
    if (existsSync(original)) renameSync(original, stashPath(rel));
  }
  writeFileSync(join(root, "src/app/page.tsx"), DESKTOP_HOME);

  const result = spawnSync("npx", ["next", "build", "--turbopack"], {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, NEXT_BUILD_TARGET: "desktop" },
  });
  status = result.status ?? 1;
} finally {
  // Remove the temporary desktop home before restoring the real one.
  rmSync(join(root, "src/app/page.tsx"), { force: true });
  restoreOnce();
}

process.exit(status);
