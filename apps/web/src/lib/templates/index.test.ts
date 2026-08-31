import { describe, expect, it } from "bun:test";

// `TEMPLATES` resolves node data through `NODE_REGISTRY`, which pulls in every
// node component, and some of them read the web env at import time. Seed it
// before the dynamic imports below — under `bun test` there is no Vite to
// supply it.
process.env.VITE_SERVER_URL ??= "http://localhost:3000";
const { COMPONENT_EMITS, COMPONENT_PORTS, isComponentType } = await import(
  "../../components/flow/nodes/_base/_base.types"
);
const { NODE_REGISTRY } = await import("../../components/flow/nodes/_REGISTRY");
const { TEMPLATES } = await import(".");

// Templates are plain @xyflow Node/Edge objects, so nothing type-checks their
// handles against the generated port/emit catalog. This suite is that guard:
// a template edge naming a handle the Rust component never declared would load
// visually but silently never fire.
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
          const parsed = NODE_REGISTRY[node.type].schema.safeParse(node.data);
          expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
        }
      });

      it("edges connect existing nodes via declared emits and ports", () => {
        const byId = new Map(template.nodes.map((n) => [n.id, n]));
        for (const edge of template.edges) {
          const source = byId.get(edge.source);
          const target = byId.get(edge.target);
          expect(source).toBeDefined();
          expect(target).toBeDefined();
          if (!source?.type || !target?.type) continue;
          if (!isComponentType(source.type) || !isComponentType(target.type)) continue;

          const emits: readonly string[] = COMPONENT_EMITS[source.type];
          const ports: readonly string[] = COMPONENT_PORTS[target.type];
          expect(emits).toContain(edge.sourceHandle);
          expect(ports).toContain(edge.targetHandle);
        }
      });
    });
  }
});
