import { execSync } from "node:child_process";

// Automated part of Gate 0. Manual checks (staging deploy, restore drill) are tracked
// in docs/PROGRESS.md section 4.
const commands = [
  "node scripts/verify-build-config.mjs",
  "npm run lint",
  "npm run typecheck",
  "npm run test",
  "npm run build:web",
  "npm run build:desktop",
  "npm run test:e2e",
];

for (const command of commands) {
  console.log(`\n$ ${command}`);
  try {
    execSync(command, { stdio: "inherit" });
  } catch {
    console.error(`\nGate 0 verification FAILED at: ${command}`);
    process.exit(1);
  }
}

console.log("\nGate 0 verification PASSED");
