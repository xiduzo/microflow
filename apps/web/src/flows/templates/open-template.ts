// Start from a template: open a flow that holds the template's nodes and
// edges, and work out what to tell the user. Where that flow lands is the
// landing rule's (`../open-flow.ts`): signed in, a new flow in the account
// under the template's name; signed out, the local flow. Choosing a template
// again starts again: it is another new flow in the account, and the flow an
// earlier choice made stays as its user left it.
//
// React-free; `useOpenTemplate` carries the report out (the toast, the error
// report, the list of flows).

import type { FlowEdge, FlowNode } from "@microflow/collab";

import type { FlowContent, FlowDestination, OpenedFlow } from "../open-flow";
import type { Template } from "./types";

export type TemplatePorts = {
  /** `openFlowFromContent`, bound to the app. */
  open(content: FlowContent, destination: FlowDestination): Promise<OpenedFlow>;
  /** Create a flow in the signed-in user's account: `flow.createFromImport`. */
  createInAccount(flow: {
    name: string;
    nodes: FlowNode[];
    edges: FlowEdge[];
  }): Promise<{ id: string; name: string }>;
};

/** How starting from a template went, as what the caller has to carry out. */
export type TemplateReport = {
  /** Where the template's flow was opened. Absent when no flow was opened. */
  where?: "account" | "local";
  /** What to tell the user, when there is something to tell. */
  message?: { level: "success" | "error"; title: string; description?: string };
  /**
   * Something that went wrong in the app (the local flow could not be saved)
   * and should be reported. An account that does not create the flow, or
   * cannot be reached, is an answer, not a failure.
   */
  failure?: unknown;
};

/**
 * Open a flow started from `template`. Does not reject: every outcome is a
 * report.
 *
 * When the account cannot create the flow, the user is told and nothing else
 * changes; the local flow is not used instead.
 */
export async function openTemplate(template: Template, ports: TemplatePorts): Promise<TemplateReport> {
  const opened = await ports.open(
    { nodes: template.nodes, edges: template.edges },
    { account: (content) => ports.createInAccount({ name: template.name, ...content }) },
  );

  if (!opened.ok) {
    const description = opened.error instanceof Error ? opened.error.message : undefined;
    if (opened.where === "account") {
      return {
        message: { level: "error", title: "Couldn't create a flow from the template", description },
      };
    }
    return {
      message: { level: "error", title: "Couldn't load the template", description },
      failure: opened.error,
    };
  }

  if (opened.where === "local") return { where: "local" };
  return {
    where: "account",
    message: {
      level: "success",
      title: "Flow created",
      description: `${opened.name} has been added to your flows`,
    },
  };
}
