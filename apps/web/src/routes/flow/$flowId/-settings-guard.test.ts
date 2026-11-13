// The leading `-` keeps the TanStack Router generator from treating this file as a route.
import { describe, expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";

// The route module reaches the tRPC client, which validates the web env at import.
process.env.VITE_SERVER_URL ??= "http://localhost:3000";
const { Route } = await import("./settings");

type BeforeLoad = (ctx: { params: { flowId: string } }) => Promise<unknown>;
const beforeLoad = Route.options.beforeLoad as unknown as BeforeLoad;

describe("/flow/$flowId/settings guard", () => {
  test("the local flow has no settings page: it redirects home", async () => {
    // `return redirect(...)` would hand the redirect down as route context and
    // render the page anyway; only a thrown redirect navigates.
    const thrown = await beforeLoad({ params: { flowId: "local" } }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { to?: string } }).options.to).toBe("/");
  });

  test("a cloud flow passes through", async () => {
    await expect(beforeLoad({ params: { flowId: "abc" } })).resolves.toEqual({ flowId: "abc" });
  });
});
