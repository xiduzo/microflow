// Post-rollout smoke suite: `bun run smoke:live`.
//
// Runs against a deployed site, not a local build: the `@live`-tagged browser
// flows in `*.smoke.ts` (local flows only, nothing written to the server) and
// the server checks in `*.live.ts`. Like the local suite it attaches over CDP
// to a running engine (`SMOKE_CDP_URL`, Obscura); no `--allow-private-network`
// is needed for public URLs.
//
//   SMOKE_BASE_URL    the web app   (default https://microflow.tech)
//   SMOKE_SERVER_URL  the server    (default https://server.microflow.tech)
//   SMOKE_DOCS_URL    the docs site (default https://docs.microflow.tech)
//   SMOKE_BYPASS_TOKEN  optional; sent as the `x-microflow-smoke` header (see
//                     e2e/bypass.ts), which a Cloudflare rule lets past its
//                     bot challenge. GitHub's runners get the challenge.
import { defineConfig } from "@playwright/test";
import { bypassHeaders } from "./e2e/bypass";
import type { SmokeOptions } from "./e2e/fixtures";

const BASE_URL = process.env.SMOKE_BASE_URL ?? "https://microflow.tech";
const SERVER_URL = process.env.SMOKE_SERVER_URL ?? "https://server.microflow.tech";
const CI = !!process.env.CI;

export default defineConfig<SmokeOptions>({
  testDir: "e2e",
  testMatch: ["*.smoke.ts", "*.live.ts"],
  grep: /@live/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  // The network between here and production can blip; one retry tells a blip
  // from a broken deploy.
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    // The deployed app talks to its real server (auth session, supporters).
    allowedOrigins: [new URL(SERVER_URL).origin],
    // Obscura sends these on page loads and same-origin requests, not on
    // cross-origin fetches; only the pages are challenged.
    extraHTTPHeaders: bypassHeaders(),
  },
});
