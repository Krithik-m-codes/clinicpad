// Applies the upstream React fix facebook/react#36134 ("Fix useDeferredValue getting stuck", merged 2026-03-24)
// to the React DOM builds that Next.js 15.5 bundles into the app (node_modules/next/dist/compiled/react-dom*).
//
// Bug: a ping that arrives synchronously during the render phase, while the render is already "suspended with
// delay", is dropped, so the transition lane is marked suspended and never retried. In the app, a server action
// whose revalidatePath response streams in leaves useActionState pending forever (AGENTS.md section 10;
// .superpowers/sdd/2026-11-17-phase-1d-sharing-import-hardening/debug-pad-settings-report.md).
//
// Runs on postinstall. Idempotent. tests/unit/vendored-react-ping.test.ts fails if the bundled React still has
// the bug, so a Next.js upgrade that changes these files is caught there.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "/* clinicpad: facebook/react#36134 */";
const root = fileURLToPath(new URL("..", import.meta.url));
const compiled = join(root, "node_modules", "next", "dist", "compiled");
// "&& prepareFreshStack(root, 0)" in the render-phase branch of pingSuspendedRoot: production and development builds.
const BUGGY = /\?\s*(0 === \(executionContext & 2\)|\(executionContext & RenderContext\) === NoContext)\s*&&\s*prepareFreshStack\(root, 0\)/;

function patchFile(file) {
  const text = readFileSync(file, "utf8");
  const start = text.indexOf("function pingSuspendedRoot(");
  if (start === -1) return "skip";
  const end = text.indexOf("function retryTimedOutBoundary(", start);
  const body = text.slice(start, end === -1 ? undefined : end);
  if (body.includes(MARKER)) return "already";
  if (!BUGGY.test(body)) return "unknown";
  const fixed = body.replace(
    BUGGY,
    (_, notRendering) =>
      `? (${notRendering} ? prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes)) ${MARKER}`,
  );
  writeFileSync(file, text.slice(0, start) + fixed + (end === -1 ? "" : text.slice(end)));
  return "patched";
}

if (!existsSync(compiled)) {
  console.log("patch-react-ping: next is not installed; nothing to patch");
  process.exit(0);
}

const results = { patched: [], already: [], unknown: [] };
for (const dir of ["react-dom", "react-dom-experimental"]) {
  const cjs = join(compiled, dir, "cjs");
  if (!existsSync(cjs)) continue;
  for (const name of readdirSync(cjs)) {
    if (!/^react-dom-(client|profiling|unstable_testing)\..*\.js$/.test(name)) continue;
    const outcome = patchFile(join(cjs, name));
    if (outcome !== "skip") results[outcome].push(`${dir}/${name}`);
  }
}

console.log(`patch-react-ping: patched ${results.patched.length}, already patched ${results.already.length}`);
if (results.unknown.length > 0) {
  // A Next.js upgrade changed these files. Check whether the bundled React already has the fix; the
  // regression test tests/unit/vendored-react-ping.test.ts answers that.
  console.warn(`patch-react-ping: WARNING, unrecognised pingSuspendedRoot in: ${results.unknown.join(", ")}`);
}
