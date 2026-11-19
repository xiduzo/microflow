import { describe, expect, test } from "bun:test";
import { FlowDocument, type FlowEdge, type FlowNode } from "@microflow/collab";

import { MAX_NAME_LENGTH } from "../flow-file";
import { openFlowFromContent, type FlowContent, type FlowDestination } from "../open-flow";
import { TEMPLATES } from ".";
import { openTemplate } from "./open-template";

const BLINK = TEMPLATES.find((template) => template.id === "blink")!;
const BLINK_CONTENT: FlowContent = { nodes: BLINK.nodes, edges: BLINK.edges };

const note = (id: string): FlowNode => ({ id, type: "Note", position: { x: 0, y: 0 }, data: {} });

/**
 * The app around a template, in memory: the real landing rule, a local flow
 * that already holds somebody's work, and an account that keeps the flows it
 * is asked to create, each under an id of its own.
 */
function world(options: { signedIn: boolean; accountFails?: boolean; localStoreFails?: boolean }) {
  const local = FlowDocument.createEmpty();
  local.setFlowData([note("mine")], []);

  const account = new Map<string, { name: string; nodes: FlowNode[]; edges: FlowEdge[] }>();
  const steps: string[] = [];

  const ports = {
    open: (content: FlowContent, destination: FlowDestination) =>
      openFlowFromContent(content, destination, {
        signedIn: options.signedIn,
        async saveLocalFlow(nodes, edges) {
          if (options.localStoreFails) throw new Error("IndexedDB will not open");
          local.setFlowData(nodes, edges);
        },
        setActiveFlowId: (flowId) => steps.push(`active ${flowId}`),
        navigate: (flowId) => steps.push(`show ${flowId}`),
      }),
    async createInAccount(flow: { name: string; nodes: FlowNode[]; edges: FlowEdge[] }) {
      if (options.accountFails) throw new Error("Failed to fetch");
      const id = `flow-${account.size + 1}`;
      // A copy, as the server stores one: a later edit of one flow is not an edit of another.
      account.set(id, structuredClone(flow));
      return { id, name: flow.name };
    },
  };

  return { ports, account, steps, localFlow: () => local.getFlowData() };
}

const MINE = world({ signedIn: false }).localFlow();

describe("openTemplate: signed in", () => {
  test("the template becomes a new flow in the account, under its name, and that flow is opened", async () => {
    const { ports, account, steps, localFlow } = world({ signedIn: true });

    const report = await openTemplate(BLINK, ports);

    expect([...account]).toEqual([["flow-1", { name: "Blink", ...BLINK_CONTENT }]]);
    expect(steps).toEqual(["active flow-1", "show flow-1"]);
    expect(report).toEqual({
      where: "account",
      message: { level: "success", title: "Flow created", description: "Blink has been added to your flows" },
    });
    // The local flow is somebody's work; a template that lands in the account leaves it alone.
    expect(localFlow()).toEqual(MINE);
  });

  test("the same template again is a second flow, a fresh start: the first is neither reopened nor overwritten", async () => {
    const { ports, account, steps } = world({ signedIn: true });

    await openTemplate(BLINK, ports);
    // The user changes the flow the template gave them.
    account.get("flow-1")!.nodes.pop();
    const again = await openTemplate(BLINK, ports);

    expect(again.where).toBe("account");
    expect([...account.keys()]).toEqual(["flow-1", "flow-2"]);
    expect(account.get("flow-2")).toEqual({ name: "Blink", ...BLINK_CONTENT });
    expect(account.get("flow-1")!.nodes).toHaveLength(BLINK.nodes.length - 1);
    expect(steps).toEqual(["active flow-1", "show flow-1", "active flow-2", "show flow-2"]);
  });

  test("when the account cannot create the flow, the user is told, nothing is opened, and the local flow is not used instead", async () => {
    const { ports, account, steps, localFlow } = world({ signedIn: true, accountFails: true });

    const report = await openTemplate(BLINK, ports);

    expect(report).toEqual({
      message: {
        level: "error",
        title: "Couldn't create a flow from the template",
        description: "Failed to fetch",
      },
    });
    expect(account.size).toBe(0);
    expect(steps).toEqual([]);
    expect(localFlow()).toEqual(MINE);
  });
});

describe("openTemplate: signed out", () => {
  test("the template replaces the local flow, which is opened; no account is asked", async () => {
    const { ports, account, steps, localFlow } = world({ signedIn: false });

    const report = await openTemplate(BLINK, ports);

    expect(report).toEqual({ where: "local" });
    expect(localFlow()).toEqual(BLINK_CONTENT);
    expect(steps).toEqual(["active local", "show local"]);
    expect(account.size).toBe(0);
  });

  test("when the local flow cannot be saved, the user is told, nothing is opened, and the failure is to be reported", async () => {
    const { ports, steps, localFlow } = world({ signedIn: false, localStoreFails: true });

    const report = await openTemplate(BLINK, ports);

    expect(report.where).toBeUndefined();
    expect(report.message).toEqual({
      level: "error",
      title: "Couldn't load the template",
      description: "IndexedDB will not open",
    });
    expect((report.failure as Error).message).toBe("IndexedDB will not open");
    expect(steps).toEqual([]);
    expect(localFlow()).toEqual(MINE);
  });
});

describe("TEMPLATES, as flows in an account", () => {
  test("every template has a name a flow may carry", () => {
    for (const template of TEMPLATES) {
      expect(template.name.trim().length, template.id).toBeGreaterThan(0);
      expect(template.name.length, template.id).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    }
  });
});
