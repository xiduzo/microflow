import { describe, expect, it } from "bun:test";

import { isComponentType } from "@/nodes/component-types.generated";
import { NODE_CATALOG } from "@/nodes/catalog.generated";
import { checkEdge } from "@/nodes/handles";
import { TEMPLATES } from ".";

// Templates are plain @xyflow Node/Edge objects, so nothing type-checks their
// handles. This suite is that guard. Every edge must attach to the Live Handle
// Set of its nodes as the template configures them: an edge to a handle the
// node does not render for those settings would be in the flow, and in the
// runtime, without ever showing on the canvas.
describe("TEMPLATES", () => {
  it("has unique template ids", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const template of TEMPLATES) {
    describe(template.name, () => {
      it("uses only catalog component types", () => {
        for (const node of template.nodes) {
          expect(isComponentType(node.type ?? "")).toBe(true);
        }
      });

      it("has unique node and edge ids", () => {
        const nodeIds = template.nodes.map((n) => n.id);
        expect(new Set(nodeIds).size).toBe(nodeIds.length);
        const edgeIds = template.edges.map((e) => e.id);
        expect(new Set(edgeIds).size).toBe(edgeIds.length);
      });

      it("node data passes each node's own schema", () => {
        for (const node of template.nodes) {
          if (!isComponentType(node.type)) continue; // caught by the type guard above
          const parsed = NODE_CATALOG[node.type].schema.safeParse(node.data);
          expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
        }
      });

      it("every edge attaches to a handle its nodes offer as configured", () => {
        const byId = new Map(template.nodes.map((n) => [n.id, n]));
        for (const edge of template.edges) {
          // The edge id rides along so a failure names the edge.
          expect({ edge: edge.id, problem: checkEdge(edge, (id) => byId.get(id)) }).toEqual({
            edge: edge.id,
            problem: null,
          });
        }
      });
    });
  }
});
