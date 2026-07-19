import { AnimatedEdge } from "./animated-edge";

export const EDGE_TYPES = {
  // `default` too: template/imported edges carry no `type`, and without this
  // they'd fall back to React Flow's plain edge and never animate signals.
  default: AnimatedEdge,
  animated: AnimatedEdge,
} as const;
