import { readFileSync } from "node:fs";

const nextConfig = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const checks = [
  ["desktop switch exists", nextConfig.includes("NEXT_BUILD_TARGET")],
  ["static export is conditional", nextConfig.includes("isDesktop")],
  ["build errors are strict", !nextConfig.includes("ignoreBuildErrors: true")],
  ["lint errors are strict", !nextConfig.includes("ignoreDuringBuilds: true")],
  ["web build script exists", typeof pkg.scripts?.["build:web"] === "string"],
  ["desktop build script exists", typeof pkg.scripts?.["build:desktop"] === "string"],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
}
process.exit(failed === 0 ? 0 : 1);
