// The last suite lands content in the app's own local flow, which opens its store.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FlowDocument, type FlowEdge, type FlowNode } from "@microflow/collab";

import { nodeHandles } from "@/nodes/handles";
import {
  acquireLocalSession,
  evictSession,
  loadLocalFlow,
  provideHandleSets,
  saveLocalFlow,
} from "@/session";
import {
  openFlowFromContent,
  type FlowContent,
  type FlowDestination,
  type FlowLanding,
} from "./open-flow";

const led = (id: string): FlowNode => ({ id, type: "Led", position: { x: 0, y: 0 }, data: { pin: 13 } });
const wire = (id: string, source: string, target: string): FlowEdge => ({
  id,
  source,
  sourceHandle: "value",
  target,
  targetHandle: "toggle",
});

const CONTENT: FlowContent = { nodes: [led("a"), led("b")], edges: [wire("e", "a", "b")] };

/**
 * The app around the operation, in memory: the local flow is a real
 * `FlowDocument` that already holds a flow, the active flow and the editor are
 * recorded, and the account is a stub that records what it was asked to create.
 */
function world(options: { signedIn: boolean; localStoreFails?: boolean; accountFails?: boolean }) {
  const local = FlowDocument.createEmpty();
  local.setFlowData([led("before-1"), led("before-2")], [wire("before", "before-1", "before-2")]);

  const steps: string[] = [];
  const created: FlowContent[] = [];

  const landing: FlowLanding = {
    signedIn: options.signedIn,
    async saveLocalFlow(nodes, edges) {
      if (options.localStoreFails) throw new Error("IndexedDB will not open");
      local.setFlowData(nodes, edges);
    },
    setActiveFlowId: (flowId) => steps.push(`active ${flowId}`),
    navigate: (flowId) => steps.push(`show ${flowId}`),
  };

  const account = async (content: FlowContent) => {
    created.push(content);
    if (options.accountFails) throw new Error("name too long");
    return { id: "flow-9", name: "Imported flow" };
  };

  return { landing, account, steps, created, localFlow: () => local.getFlowData() };
}

const BEFORE = world({ signedIn: false }).localFlow();

describe("openFlowFromContent: into the account", () => {
  test("signed in, the flow is created in the account and that flow is opened", async () => {
    const { landing, account, steps, created, localFlow } = world({ signedIn: true });

    const opened = await openFlowFromContent(CONTENT, { account }, landing);

    expect(opened).toEqual({ ok: true, where: "account", flowId: "flow-9", name: "Imported flow" });
    expect(created).toEqual([CONTENT]);
    expect(steps).toEqual(["active flow-9", "show flow-9"]);
    // The local flow is somebody's work; a flow that lands in the account leaves it alone.
    expect(localFlow()).toEqual(BEFORE);
  });

  test("signed out, the same request replaces the local flow and opens it", async () => {
    const { landing, account, steps, created, localFlow } = world({ signedIn: false });

    const opened = await openFlowFromContent(CONTENT, { account }, landing);

    expect(opened).toEqual({ ok: true, where: "local", flowId: "local" });
    expect(created).toEqual([]);
    // Nothing of the flow it held is left.
    expect(localFlow()).toEqual(CONTENT);
    expect(steps).toEqual(["active local", "show local"]);
  });

  test("when the account refuses, nothing is opened and the local flow is not a fallback", async () => {
    const { landing, account, steps, localFlow } = world({ signedIn: true, accountFails: true });

    const opened = await openFlowFromContent(CONTENT, { account }, landing);

    expect(opened).toMatchObject({ ok: false, where: "account" });
    expect(!opened.ok && (opened.error as Error).message).toBe("name too long");
    expect(steps).toEqual([]);
    expect(localFlow()).toEqual(BEFORE);
  });
});

describe("openFlowFromContent: into the local flow", () => {
  test("when the local store fails, nothing is opened", async () => {
    const { landing, account, steps, localFlow } = world({ signedIn: false, localStoreFails: true });

    const opened = await openFlowFromContent(CONTENT, { account }, landing);

    expect(opened).toMatchObject({ ok: false, where: "local" });
    expect(!opened.ok && (opened.error as Error).message).toBe("IndexedDB will not open");
    expect(steps).toEqual([]);
    expect(localFlow()).toEqual(BEFORE);
  });
});

// A template's own route is `openTemplate`, in `templates/open-template.test.ts`.
describe("openFlowFromContent: as each route asks", () => {
  test("an import creates the flow from the content it is given", async () => {
    const { landing, steps } = world({ signedIn: true });
    const sent: unknown[] = [];
    const createFromImport = async (input: { name: string; nodes: FlowNode[]; edges: FlowEdge[] }) => {
      sent.push(input);
      return { id: "flow-1", name: input.name };
    };

    const opened = await openFlowFromContent(
      CONTENT,
      { account: ({ nodes, edges }) => createFromImport({ name: "Blink", nodes, edges }) },
      landing,
    );

    expect(sent).toEqual([{ name: "Blink", ...CONTENT }]);
    expect(opened).toEqual({ ok: true, where: "account", flowId: "flow-1", name: "Blink" });
    expect(steps).toEqual(["active flow-1", "show flow-1"]);
  });

  test("a Community fork copies on the server when signed in, and copies the content when signed out", async () => {
    const forked: string[] = [];
    const fork = async (input: { id: string }) => {
      forked.push(input.id);
      return { id: "copy-1", name: "Blink" };
    };
    const destination = { account: () => fork({ id: "community-7" }) };

    const signedIn = world({ signedIn: true });
    expect(await openFlowFromContent(CONTENT, destination, signedIn.landing)).toEqual({
      ok: true,
      where: "account",
      flowId: "copy-1",
      name: "Blink",
    });
    expect(forked).toEqual(["community-7"]);
    expect(signedIn.localFlow()).toEqual(BEFORE);

    const signedOut = world({ signedIn: false });
    expect(await openFlowFromContent(CONTENT, destination, signedOut.landing)).toEqual({
      ok: true,
      where: "local",
      flowId: "local",
    });
    expect(forked).toEqual(["community-7"]);
    expect(signedOut.localFlow()).toEqual(CONTENT);
    expect(signedOut.steps).toEqual(["active local", "show local"]);
  });
});

// The local flow as the app holds it: the session registry over IndexedDB, its
// session pruning the edges of a vanished handle with the real Handle Rules
// (`main.tsx` provides them). Landing replaces content; it is not an edit of
// the nodes that were there, even where an id is the same.
describe("openFlowFromContent: into the app's own local flow", () => {
  /**
   * Start from, and leave behind, no local flow at all: no session in the
   * registry and no stored document (`IndexeddbSyncAdapter`'s store), so this
   * suite neither depends on nor feeds a test that runs before or after it.
   */
  async function forgetLocalFlow(): Promise<void> {
    evictSession("local");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("microflow-local-flow");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  beforeEach(async () => {
    await forgetLocalFlow();
    provideHandleSets(nodeHandles);
  });
  afterEach(async () => {
    provideHandleSets(null);
    await forgetLocalFlow();
  });

  test("starts from an empty local flow", async () => {
    expect(await loadLocalFlow()).toEqual({ nodes: [], edges: [] });
  });

  const landing: FlowLanding = { signedIn: false, saveLocalFlow, setActiveFlowId() {}, navigate() {} };
  // Nobody is signed in, so there is no account to ask.
  const destination: FlowDestination = {
    account: async () => {
      throw new Error("no account");
    },
  };

  const mqtt = (direction: "publish" | "subscribe"): FlowNode => ({
    id: "n1",
    type: "Mqtt",
    position: { x: 0, y: 0 },
    data: { direction },
  });
  const monitor: FlowNode = { id: "monitor", type: "Monitor", position: { x: 400, y: 0 }, data: {} };
  // Leaves `n1` at `value`, which only a subscribing Mqtt node offers.
  const fromValue: FlowEdge = { id: "e", source: "n1", sourceHandle: "value", target: "monitor", targetHandle: "value" };

  test("content with an edge at a handle its node does not offer lands whole, over a node of the same id that offered it", async () => {
    // The editor has the local flow open, so one session sees both flows.
    acquireLocalSession();
    await saveLocalFlow([mqtt("subscribe"), monitor], [{ ...fromValue, id: "old" }]);

    const incoming: FlowContent = { nodes: [mqtt("publish"), monitor], edges: [fromValue] };
    const opened = await openFlowFromContent(incoming, destination, landing);

    expect(opened).toEqual({ ok: true, where: "local", flowId: "local" });
    expect(await loadLocalFlow()).toEqual(incoming);
  });

  test("an edit to the landed flow in that session still takes the edges of the handle it removes", async () => {
    const editor = acquireLocalSession();
    const incoming: FlowContent = { nodes: [mqtt("subscribe"), monitor], edges: [fromValue] };
    await openFlowFromContent(incoming, destination, landing);
    expect((await loadLocalFlow()).edges).toEqual([fromValue]);

    editor.doc.updateNodeData("n1", { direction: "publish" });

    expect((await loadLocalFlow()).edges).toEqual([]);
  });
});
