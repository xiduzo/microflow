// Open a flow from content: the one landing rule for a flow that arrives as
// nodes and edges (an imported file, a template, a Community flow) and has to
// become a flow the editor shows.
//
// **The rule.** Signed in, the content lands in the user's account, as a new
// flow that the caller's `FlowDestination` creates there. Signed out, it
// replaces the local flow, the one flow that lives on this device. The flow it
// landed in then becomes the active flow and the editor shows it. When landing
// fails nothing else happens: the active flow stays, the editor is not opened,
// and content the account could not take does not land in the local flow
// instead, which may hold work of its own.
//
// React-free. `FlowLanding` is the seam to the app around it: `use-open-flow.ts`
// binds it to the session, the active-flow store and the router; the tests bind
// it to a `FlowDocument` in memory.

import type { FlowEdge, FlowNode } from "@microflow/collab";

/** The id of the local flow, as a flow id and as a route parameter. */
const LOCAL_FLOW_ID = "local";

export type FlowContent = { nodes: FlowNode[]; edges: FlowEdge[] };

/**
 * How the content becomes a flow in the signed-in user's account: `account`
 * creates a flow there and returns it. Each call creates one; none reopens or
 * overwrites a flow that is already there. It is the caller's tRPC mutation: an
 * import and a template create the flow from the content, a Community fork
 * copies it on the server and ignores the content. Not called when nobody is
 * signed in.
 */
export type FlowDestination = {
  account: (content: FlowContent) => Promise<{ id: string; name: string }>;
};

/** What opening a flow needs from the app around it. */
export type FlowLanding = {
  /** Whether somebody is signed in, so there is an account to create flows in. */
  signedIn: boolean;
  /** Replace the contents of the local flow. */
  saveLocalFlow(nodes: FlowNode[], edges: FlowEdge[]): Promise<void>;
  setActiveFlowId(flowId: string): void;
  /** Show a flow in the editor. */
  navigate(flowId: string): void;
};

/**
 * How it went. `where` is where the content landed, or was meant to when
 * `ok` is false; `error` is then what the account or the local store threw.
 */
export type OpenedFlow =
  | { ok: true; where: "account"; flowId: string; name: string }
  | { ok: true; where: "local"; flowId: typeof LOCAL_FLOW_ID }
  | { ok: false; where: "account" | "local"; error: unknown };

/**
 * Land `content` through `destination` and open the flow it landed in.
 *
 * Does not reject: a failure of the account or of the local store is the
 * `ok: false` result.
 */
export async function openFlowFromContent(
  content: FlowContent,
  destination: FlowDestination,
  landing: FlowLanding,
): Promise<OpenedFlow> {
  const where = landing.signedIn ? "account" : "local";

  let opened: Extract<OpenedFlow, { ok: true }>;
  try {
    if (where === "account") {
      const { id, name } = await destination.account(content);
      opened = { ok: true, where, flowId: id, name };
    } else {
      await landing.saveLocalFlow(content.nodes, content.edges);
      opened = { ok: true, where, flowId: LOCAL_FLOW_ID };
    }
  } catch (error) {
    return { ok: false, where, error };
  }

  landing.setActiveFlowId(opened.flowId);
  landing.navigate(opened.flowId);
  return opened;
}
