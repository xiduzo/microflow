// Import a flow file: turn the file away or decode it, open the flow, and
// work out what to tell the user and what to record. Everything an import
// decides is here and none of it touches the DOM; `useImportFlow` picks the
// file and carries the report out (toasts, analytics, the error report).

import {
  decodeFlowFile,
  refuseFlowFileOfSize,
  type DecodedFlow,
  type FlowFileNotice,
} from "./flow-file";
import type { FlowContent, FlowDestination, OpenedFlow } from "./open-flow";

/** The name of an imported flow whose file has none. */
const UNNAMED = "Imported flow";

/** How many notices are shown in full; the rest are counted by kind. */
const SHOWN_NOTICES = 8;

/**
 * Every kind of notice, most important first: what was left out, then what
 * will not work, then what was assumed. With each, how to count the ones that
 * are not shown in full.
 */
const NOTICE_KINDS: Record<FlowFileNotice["kind"], (count: number) => string> = {
  "edge-dropped": (n) => (n === 1 ? "1 edge left out" : `${n} edges left out`),
  "unknown-node-type": (n) => (n === 1 ? "1 node of an unknown type" : `${n} nodes of an unknown type`),
  "settings-unrecognised": (n) =>
    n === 1 ? "1 node with settings kept as they are" : `${n} nodes with settings kept as they are`,
  "unknown-handle": (n) => (n === 1 ? "1 edge at an unknown handle" : `${n} edges at an unknown handle`),
  "name-shortened": () => "the name shortened",
  "edges-not-drawn": () => "edges the canvas does not show",
  "position-defaulted": (n) => (n === 1 ? "1 node without a position" : `${n} nodes without a position`),
  "settings-defaulted": (n) => (n === 1 ? "1 node given default settings" : `${n} nodes given default settings`),
};
const NOTICE_ORDER = Object.keys(NOTICE_KINDS) as FlowFileNotice["kind"][];

/** The parts of a `File` an import reads. */
export type FlowFileSource = { size: number; text(): Promise<string> };

/** One thing to tell the user, as plain text. */
export type ImportMessage = {
  level: "success" | "error" | "warning";
  title: string;
  description?: string;
};

/** How an import went, as what the caller has to carry out. */
export type ImportReport = {
  /** What to tell the user, in order. */
  messages: ImportMessage[];
  /**
   * Present when the flow was imported, and only then: where it landed and
   * how big it is. The import counts for analytics exactly when this is set.
   */
  imported?: { where: "account" | "local"; nodes: number; edges: number };
  /**
   * Something that went wrong in the app (the file could not be read, the
   * local flow could not be saved) and should be reported. A file that is
   * refused and an account that refuses the flow are answers, not failures.
   */
  failure?: unknown;
};

export type ImportPorts = {
  /** `openFlowFromContent`, bound to the app. */
  open(content: FlowContent, destination: FlowDestination): Promise<OpenedFlow>;
  /** Create the flow in the signed-in user's account: `flow.createFromImport`. */
  createInAccount(flow: Required<DecodedFlow>): Promise<{ id: string; name: string }>;
};

/**
 * Import the flow in `file`. Does not reject: every outcome is a report.
 *
 * A file that is too large is turned away unread.
 */
export async function importFlowFile(file: FlowFileSource, ports: ImportPorts): Promise<ImportReport> {
  const tooLarge = refuseFlowFileOfSize(file.size);
  if (tooLarge) return { messages: [failed(tooLarge.problem)] };

  let text: string;
  try {
    text = await file.text();
  } catch (failure) {
    return { messages: [failed("The file could not be read.")], failure };
  }

  const decoded = decodeFlowFile(text);
  if (!decoded.ok) return { messages: [failed(decoded.problem)] };

  const { name = UNNAMED, nodes, edges } = decoded.flow;
  const opened = await ports.open(
    { nodes, edges },
    { account: (content) => ports.createInAccount({ name, ...content }) },
  );

  if (!opened.ok) {
    const description = opened.error instanceof Error ? opened.error.message : undefined;
    if (opened.where === "account") return { messages: [failed(description)] };
    return {
      messages: [{ level: "error", title: "Couldn't import the flow", description }],
      failure: opened.error,
    };
  }

  const description =
    opened.where === "account" ? `${opened.name} has been created` : `${nodes.length} nodes, ${edges.length} edges`;
  return {
    messages: [{ level: "success", title: "Flow imported", description }, ...aboutNotices(decoded.notices)],
    imported: { where: opened.where, nodes: nodes.length, edges: edges.length },
  };
}

function failed(description: string | undefined): ImportMessage {
  return { level: "error", title: "Failed to import flow", description };
}

/**
 * One message for all the notices: the most important ones in full, the rest
 * counted by kind, so that nothing left out of the flow goes unmentioned
 * however many notices there are.
 */
function aboutNotices(notices: FlowFileNotice[]): ImportMessage[] {
  if (notices.length === 0) return [];
  const ordered = NOTICE_ORDER.flatMap((kind) => notices.filter((notice) => notice.kind === kind));

  const lines = ordered.slice(0, SHOWN_NOTICES).map((notice) => notice.message);
  const rest = ordered.slice(SHOWN_NOTICES);
  if (rest.length > 0) {
    const counts = NOTICE_ORDER.flatMap((kind) => {
      const of = rest.filter((notice) => notice.kind === kind).length;
      return of > 0 ? [NOTICE_KINDS[kind](of)] : [];
    });
    lines.push(`…and ${rest.length} more: ${counts.join(", ")}.`);
  }

  return [
    {
      level: "warning",
      title:
        notices.length === 1
          ? "One thing to check in the imported flow"
          : `${notices.length} things to check in the imported flow`,
      description: lines.join("\n"),
    },
  ];
}
