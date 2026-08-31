import type { FlowNode, FlowEdge } from "@microflow/collab";

export type Template = {
  id: string;
  name: string;
  description: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  categories?: string[];
  nodes: FlowNode[];
  edges: FlowEdge[];
};
