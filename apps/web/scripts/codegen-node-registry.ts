import manifest from "../node-components.json";
import wireInterface from "../wire-interface.generated.json";
import { existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodesDir = join(__dirname, "../src/nodes");

function toKebabCase(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

const { entries, impls } = manifest;

// An entry has a host adapter when its folder holds a `<node>.adapter.ts`
// sibling (see `_base/host-adapter.ts`). Kept out of the React file so the
// catalog can import it without pulling in the node's UI.
const entryUsesAdapter = (e: { name: string }) => {
  const kebab = toKebabCase(e.name);
  return existsSync(join(nodesDir, kebab, `${kebab}.adapter.ts`));
};

// Map impl name -> requiresHardware, so the frontend can tell which nodes are
// useless without a board (and therefore without Web Serial, in the browser).
const requiresHardware = new Map<string, boolean>(
  impls.map((i) => [i.name, Boolean((i as Record<string, unknown>).requiresHardware)]),
);
const entryRequiresHardware = (e: { impl: string }) => requiresHardware.get(e.impl) ?? false;

// Per-entry Port / Emit sets, GENERATED from the Rust impls' ports()/emits()
// into wire-interface.generated.json — the single source of truth for the wire
// interface (see src-tauri/tests/catalog_parity.rs). Keyed by entry name, so
// variants (e.g. Potentiometer over Sensor) already carry their parent impl's
// interface; there is no hand-authored impls[].ports/emits mirror to drift.
// See CONTEXT.md § Port / § Emit.
type WireInterface = Record<string, { ports: readonly string[]; emits: readonly string[] }>;
const wire = wireInterface as WireInterface;
const wireOf = (e: { name: string }) => {
  const w = wire[e.name];
  if (!w) {
    throw new Error(
      `Entry ${e.name} is missing from wire-interface.generated.json — regenerate it: ` +
        `BLESS_WIRE_INTERFACE=1 cargo test --manifest-path src-tauri/Cargo.toml --test catalog_parity`,
    );
  }
  return w;
};
const entryPorts = (e: { name: string }): readonly string[] => wireOf(e).ports;
const entryEmits = (e: { name: string }): readonly string[] => wireOf(e).emits;

// component-types.generated.ts
const typeNames = entries.map((e) => `  "${e.name}"`).join(",\n");
const portsObjectLines = entries
  .map((e) => {
    const ports = entryPorts(e);
    const literal = ports.length === 0 ? "[]" : `[${ports.map((p) => `"${p}"`).join(", ")}]`;
    return `  ${e.name}: ${literal} as const,`;
  })
  .join("\n");
const emitsObjectLines = entries
  .map((e) => {
    const emits = entryEmits(e);
    const literal = emits.length === 0 ? "[]" : `[${emits.map((p) => `"${p}"`).join(", ")}]`;
    return `  ${e.name}: ${literal} as const,`;
  })
  .join("\n");
const hardwareObjectLines = entries
  .map((e) => `  ${e.name}: ${entryRequiresHardware(e)},`)
  .join("\n");
const implObjectLines = entries.map((e) => `  ${e.name}: "${e.impl}",`).join("\n");
const baseTypesContent = `// GENERATED — do not edit. Sources: node-components.json (entries/metadata) +
// wire-interface.generated.json (ports/emits, from Rust). Run \`bun run codegen\`.

export const COMPONENT_TYPES = [
${typeNames},
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export function isComponentType(value: string): value is ComponentType {
  return COMPONENT_TYPES.includes(value as ComponentType);
}

/**
 * Declared **Port** set per Component. GENERATED from the Rust impl's
 * \`Component::ports()\` via \`wire-interface.generated.json\` — the single
 * source of truth (see \`src-tauri/tests/catalog_parity.rs\`). Type-checks the
 * target handles a ReactFlow edge may carry. Empty array for components with no
 * edge inputs (e.g. \`Constant\`). See CONTEXT.md § Port.
 */
export const COMPONENT_PORTS = {
${portsObjectLines}
} as const satisfies Record<ComponentType, readonly string[]>;

/**
 * Valid \`target_handle\` literal-union for a given Component instance type.
 * Distributive conditional ensures the result is the union of port literals
 * across all members of \`T\` when \`T\` is itself a union of ComponentTypes.
 */
export type PortOf<T extends ComponentType> = T extends ComponentType
  ? (typeof COMPONENT_PORTS)[T][number]
  : never;

/**
 * Declared **Emit** set per Component. GENERATED from the Rust impl's
 * \`Component::emits()\` via \`wire-interface.generated.json\` — the single
 * source of truth, kept current by the Catalog Parity Guard
 * (\`src-tauri/tests/catalog_parity.rs\`). Type-checks the source handles a
 * ReactFlow edge may originate from. See CONTEXT.md § Emit.
 */
export const COMPONENT_EMITS = {
${emitsObjectLines}
} as const satisfies Record<ComponentType, readonly string[]>;

/**
 * Valid \`source_handle\` literal-union for a given Component instance type.
 * Distributive conditional ensures the result is the union of emit literals
 * across all members of \`T\` when \`T\` is itself a union of ComponentTypes.
 */
export type EmitOf<T extends ComponentType> = T extends ComponentType
  ? (typeof COMPONENT_EMITS)[T][number]
  : never;

/**
 * Whether a Component drives a pin, and so cannot do anything without a board.
 * GENERATED from \`impls[].requiresHardware\` in node-components.json — the same
 * flag the Rust registry uses to decide on \`Component::initialize(board)\`.
 * The browser consults it to tell a user on a browser without Web Serial that
 * this node can never run here (see \`_base/browser-support.ts\`).
 */
export const REQUIRES_HARDWARE = {
${hardwareObjectLines}
} as const satisfies Record<ComponentType, boolean>;

/**
 * The **Variant** resolution: which \`impls\` row each entry runs as. GENERATED
 * from \`entries[].impl\` in node-components.json — the same mapping the Rust
 * \`ComponentRegistry\` uses to pick a factory. Most entries resolve to
 * themselves; a Variant resolves to its parent (\`Force\` → \`Sensor\`,
 * \`Vibration\` → \`Led\`). Surfaces so that a consumer keyed on runtime
 * behaviour — the schematic's part map — can fall back to the parent's answer
 * instead of hand-listing every Variant. See CONTEXT.md § Variant.
 */
export const COMPONENT_IMPL = {
${implObjectLines}
} as const satisfies Record<ComponentType, string>;
`;
writeFileSync(join(nodesDir, "component-types.generated.ts"), baseTypesContent);

// catalog.generated.ts — per-type metadata for non-UI code. Imports only each
// node's `.schema.ts` and `.adapter.ts`, never its React component, so the
// runtime, Ask AI and templates can read it without loading every node UI.
const catalogLines: string[] = [
  "// GENERATED — do not edit. Sources: node-components.json (entries) + each node's",
  "// `<node>.adapter.ts`, when present. Run `bun run codegen`.",
  "// React-free: imports schemas and host adapters only, never a node's UI.",
  'import type { ZodType } from "zod";',
  'import type { ComponentType } from "./component-types.generated";',
  'import type { NodeHostAdapter } from "./_base/host-adapter";',
  "",
];

for (const e of entries) {
  const kebab = toKebabCase(e.name);
  const fp = `./${kebab}/${kebab}`;
  catalogLines.push(`import { defaults as ${e.name}Defaults } from "${fp}.schema";`);
  catalogLines.push(`import { dataSchema as ${e.name}Schema } from "${fp}.schema";`);
  if (entryUsesAdapter(e)) {
    catalogLines.push(`import { adapter as ${e.name}Adapter } from "${fp}.adapter";`);
  }
}

catalogLines.push(
  "",
  "export type NodeDefaults = {",
  "  group?: string;",
  "  label?: string;",
  "  description?: string;",
  "  tags?: readonly string[];",
  "  icon?: string;",
  "  [key: string]: unknown;",
  "};",
  "",
  "export type NodeCatalogEntry = {",
  "  defaults: NodeDefaults;",
  "  /** The node's own zod schema — the authority on what its `data` may hold.",
  "   *  Exposed here so a caller holding only a type string can validate before",
  "   *  writing to the document (see `ai/flow-tools.ts`). */",
  "  schema: ZodType;",
  "  adapter?: NodeHostAdapter;",
  "};",
  "",
  "export const NODE_CATALOG = {",
);

for (const e of entries) {
  const adapterField = entryUsesAdapter(e) ? `${e.name}Adapter` : "undefined";
  catalogLines.push(
    `  ${e.name}: { defaults: ${e.name}Defaults as NodeDefaults, schema: ${e.name}Schema, adapter: ${adapterField} },`,
  );
}

catalogLines.push("} satisfies Record<ComponentType, NodeCatalogEntry>;", "");

writeFileSync(join(nodesDir, "catalog.generated.ts"), catalogLines.join("\n"));

// node-types.generated.ts — the React side: one component per entry, for
// ReactFlow's `nodeTypes`. The only generated file that loads node UIs.
const nodeTypesLines: string[] = [
  "// GENERATED — do not edit. Source: node-components.json. Run `bun run codegen`.",
  'import type { NodeTypes } from "@xyflow/react";',
  'import type { ComponentType } from "./component-types.generated";',
  "",
];

for (const e of entries) {
  const kebab = toKebabCase(e.name);
  nodeTypesLines.push(`import { ${e.name} } from "./${kebab}/${kebab}";`);
}

nodeTypesLines.push("", "// ReactFlow compatibility", "export const NODE_TYPES = {");

for (const e of entries) {
  nodeTypesLines.push(`  ${e.name},`);
}

nodeTypesLines.push("} as const satisfies NodeTypes & Record<ComponentType, unknown>;", "");

writeFileSync(join(nodesDir, "node-types.generated.ts"), nodeTypesLines.join("\n"));

console.log("✓ Generated component-types.generated.ts");
console.log("✓ Generated catalog.generated.ts");
console.log("✓ Generated node-types.generated.ts");
