import { defineConfig, devices } from "@playwright/test";

/**
 * Opt-in: the sandboxed PDF reader frame against real fixtures in Chromium, Firefox and WebKit (`npm run test:pdf-frame`).
 * It starts its own dev server on PDF_FRAME_PORT (default 3457) so it cannot collide with a server on 3000; the frame
 * route needs no database. NEXT_PUBLIC_APP_URL is set to that origin because the frame's CSP is built from it.
 */
const port = Number(process.env.PDF_FRAME_PORT ?? 3457);
const origin = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "pdf-frame-fixtures.spec.ts",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: "list",
  use: { baseURL: origin },
  webServer: {
    command: `npx next dev -p ${port}`,
    url: `${origin}/pdf-frame/frame.mjs`,
    env: { NEXT_PUBLIC_APP_URL: origin, PDF_FRAME: "1" },
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
