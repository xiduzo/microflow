// Shared fixtures for the browser smoke suite (`*.smoke.ts`).
//
// The suite never launches a browser. It attaches over CDP to one that is
// already running: Obscura locally, and Obscura on CI too (see
// .github/workflows/smoke.yml). `SMOKE_CDP_URL` picks the endpoint.
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { chromium } from "playwright-core";

export const CDP_URL = process.env.SMOKE_CDP_URL ?? "http://127.0.0.1:9222";

/**
 * What counts as an app failure on the page:
 * - `pageerror`: an uncaught exception, as the engine reports it over CDP.
 * - `[report-error]`: the console line `consoleSink` writes for every
 *   `reportError` call, i.e. anything the app itself caught and reported
 *   (boundaries, window `error`, unhandled rejections, failed actions).
 * - Obscura does not raise `pageerror` for an exception thrown in a timer
 *   callback or an inline script, and does not dispatch it to `window` either.
 *   It logs it to the console with one of these prefixes instead.
 */
const APP_ERROR = /^\[report-error\]/;
const UNCAUGHT_IN_OBSCURA = /^(Timer error|Dynamic inline script error|Uncaught)\b/;

export function watchForAppErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (APP_ERROR.test(text) || UNCAUGHT_IN_OBSCURA.test(text)) errors.push(`console: ${text}`);
  });
  return errors;
}

type Fixtures = {
  /** Every app error seen on `page` so far. Each test fails if it is not empty at the end. */
  appErrors: string[];
};

export const test = base.extend<Fixtures>({
  // Attach to the running engine instead of launching one. Playwright's own
  // `context` and `page` fixtures then work as usual on top of it: each test
  // gets a fresh context, so its storage starts empty.
  browser: [
    // Playwright reads fixture dependencies from the destructuring pattern, so
    // a fixture with none must be written `{}`.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(CDP_URL);
      await use(browser);
      // Disconnects and drops the contexts this worker made; the engine keeps running.
      await browser.close();
    },
    { scope: "worker" },
  ],

  // Keep the run hermetic: only the app under test is reachable. This also
  // keeps CI runs out of the production analytics (Umami) and off GitHub's
  // rate-limited API (the update check). Cross-origin requests the app makes
  // (auth session, analytics) fail, as they would offline.
  context: async ({ context, baseURL }, use) => {
    const origin = new URL(baseURL ?? "http://127.0.0.1").origin;
    await context.route(
      (url) => url.origin !== origin,
      (route) => route.abort("blockedbyclient"),
    );
    await use(context);
  },

  appErrors: [
    async ({ page }, use) => {
      const errors = watchForAppErrors(page);
      await use(errors);
      expect(errors, "the app reported errors or threw").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The node elements React Flow renders, on the editor canvas or inside a thumbnail. */
export function canvasNodes(scope: Page | Locator) {
  return scope.locator(".react-flow__node");
}
