// The app's wiring, as `main.tsx` runs it. If `wireApp` stops handing the
// session what it needs, sessions still work and nothing else fails: these do.

// `createLocalSession` opens the local flow's store.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalSession, provideHandleSets, type FlowSession } from "@/session";
import { wireApp } from "./app-wiring";

let session: FlowSession | undefined;
afterEach(() => {
  session?.destroy();
  session = undefined;
  provideHandleSets(null);
});

describe("wireApp", () => {
  test("a session made after it prunes with the real Handle Rules", () => {
    const reported = spyOn(console, "error").mockImplementation(() => {});
    wireApp();
    session = createLocalSession();
    const { doc } = session;
    doc.doc.transact(() => {
      doc.addNode({ id: "button", type: "Button", position: { x: 0, y: 0 }, data: {} });
      doc.addNode({ id: "mqtt", type: "Mqtt", position: { x: 0, y: 0 }, data: { direction: "publish" } });
      doc.addEdge({ id: "e", source: "button", sourceHandle: "event", target: "mqtt", targetHandle: "trigger" });
    }, "seed");

    doc.updateNodeData("mqtt", { direction: "subscribe" });

    expect(doc.getEdgeIds()).toEqual([]);
    // And the session had nothing to complain about.
    expect(reported).not.toHaveBeenCalled();
    reported.mockRestore();
  });

  test("main.tsx calls it before anything can make a session", () => {
    // `main.tsx` cannot be imported here (it mounts the app), so this reads
    // it: the call must be there, ahead of the router that renders the routes.
    const main = readFileSync(join(import.meta.dir, "main.tsx"), "utf8");
    const call = main.indexOf("wireApp();");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(main.indexOf("createRouter("));
  });
});
