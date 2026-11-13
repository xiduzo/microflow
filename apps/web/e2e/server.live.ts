// Post-rollout server checks (`bun run smoke:live`). Read-only: nothing here
// signs in, creates a flow or writes to the database.
//
// These use Playwright's plain `test` (no browser): only the request client
// and Node's WebSocket.
import { expect, test } from "@playwright/test";

const SERVER_URL = process.env.SMOKE_SERVER_URL ?? "https://server.microflow.tech";
const DOCS_URL = process.env.SMOKE_DOCS_URL ?? "https://docs.microflow.tech";
const WEB_ORIGIN = new URL(process.env.SMOKE_BASE_URL ?? "https://microflow.tech").origin;
const LIVE = { tag: "@live" };

// `CLOSE_POLICY_VIOLATION` in @microflow/collab/protocol: no session.
const CLOSE_POLICY_VIOLATION = 1008;

test("the server is up", LIVE, async ({ request }) => {
  const res = await request.get(SERVER_URL);
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe("OK");
});

test("auth answers a signed-out session", LIVE, async ({ request }) => {
  const res = await request.get(`${SERVER_URL}/api/auth/get-session`, { headers: { Origin: WEB_ORIGIN } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toBeNull();
});

// The web app and every desktop webview origin (macOS/Linux, and Windows'
// http://tauri.localhost) must pass CORS, or sign-in breaks on that platform.
for (const origin of [WEB_ORIGIN, "tauri://localhost", "http://tauri.localhost"]) {
  test(`CORS allows ${origin}`, LIVE, async ({ request }) => {
    const res = await request.fetch(`${SERVER_URL}/api/auth/get-session`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    });
    expect(res.status()).toBeLessThan(300);
    expect(res.headers()["access-control-allow-origin"]).toBe(origin);
    expect(res.headers()["access-control-allow-credentials"]).toBe("true");
  });
}

test("the public supporters list loads", LIVE, async ({ request }) => {
  const res = await request.get(`${SERVER_URL}/api/public/supporters`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.supporters)).toBe(true);
});

test("the collaboration room gate refuses a signed-out socket", LIVE, async () => {
  // A room that cannot exist; without a session the gate closes before it
  // looks the flow up, so this touches no flow and no database row.
  const url = `${SERVER_URL.replace(/^http/, "ws")}/yjs/smoke-${crypto.randomUUID()}`;
  const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`no close from ${url} within 15s`)), 15_000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    });
  });
  expect(closed).toEqual({ code: CLOSE_POLICY_VIOLATION, reason: "Unauthorized" });
});

test("the docs site is up", LIVE, async ({ request }) => {
  const res = await request.get(DOCS_URL);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("<html");
});
