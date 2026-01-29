import type { Node, Edge } from "@xyflow/react";

export type Template = {
  id: string;
  name: string;
  description: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  categories?: string[];
  nodes: Node[];
  edges: Edge[];
};
