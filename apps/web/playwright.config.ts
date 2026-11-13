// Browser smoke suite: `bun run smoke` (after `bun run build`).
//
// It runs against the built app served by `vite preview`, with no server or
// database: local flows only. It does not launch a browser; it attaches over
// CDP to a running one at `SMOKE_CDP_URL` (see e2e/fixtures.ts). Locally that
// is Obscura: `obscura serve --port 9222 --allow-private-network`.
//
// The files are `*.smoke.ts`, so `bun test` never picks them up.
import { defineConfig } from "@playwright/test";

const PORT = 4173;
// 127.0.0.1, not localhost: `vite preview` on `localhost` binds only to ::1 on
// macOS, and Obscura reaches some requests (the wasm fetch at boot) over IPv4.
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.smoke.ts",
  // One engine process, and the flows share nothing worth parallelising.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  // No retries: a flaky smoke flow is a bug to fix, not to paper over.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    command: `bunx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !CI,
    timeout: 30_000,
  },
});
