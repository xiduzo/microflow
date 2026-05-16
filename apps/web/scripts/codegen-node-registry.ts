import manifest from "../node-components.json";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodesDir = join(__dirname, "../src/components/flow/nodes");

function toKebabCase(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

const { entries, impls } = manifest;

// Map impl name -> usesHostAdapter flag, so each entry can decide whether
// to import an `adapter` export from its own component file.
const usesHostAdapter = new Map<string, boolean>(
  impls.map((i) => [i.name, Boolean((i as Record<string, unknown>).usesHostAdapter)]),
);
const entryUsesAdapter = (e: { impl: string }) => usesHostAdapter.get(e.impl) ?? false;

// Map impl name -> declared Port set. Variants (e.g. Potentiometer over
// Sensor) inherit their parent impl's ports. See CONTEXT.md § Port.
const implPorts = new Map<string, readonly string[]>(
  impls.map((i) => [
    i.name,
    Object.freeze(((i as Record<string, unknown>).ports as string[] | undefined) ?? []),
  ]),
);
const entryPorts = (e: { impl: string; name: string }): readonly string[] => {
  const ports = implPorts.get(e.impl);
  if (!ports) throw new Error(`Entry ${e.name} references unknown impl ${e.impl}`);
  return ports;
};

// _base/_base.types.ts
const typeNames = entries.map((e) => `  "${e.name}"`).join(",\n");
const portsObjectLines = entries
  .map((e) => {
    const ports = entryPorts(e);
    const literal = ports.length === 0 ? "[]" : `[${ports.map((p) => `"${p}"`).join(", ")}]`;
    return `  ${e.name}: ${literal} as const,`;
  })
  .join("\n");
const baseTypesContent = `// GENERATED — edit node-components.json, then run \`bun run codegen\`

export const COMPONENT_TYPES = [
${typeNames},
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export function isComponentType(value: string): value is ComponentType {
  return COMPONENT_TYPES.includes(value as ComponentType);
}

/**
 * Declared **Port** set per Component (catalog-driven). Mirrors
 * \`impls[].ports[]\` in \`node-components.json\` and the Rust impl's
 * \`Component::ports()\` const. The Rust registry asserts equality at
 * construction; this object is the single source of truth for what target
 * handles a ReactFlow edge may carry. Empty array for components with no
 * edge inputs (e.g. \`Constant\`). See CONTEXT.md § Port.
 */
export const COMPONENT_PORTS = {
${portsObjectLines}
} as const satisfies Record<ComponentType, readonly string[]>;

/** Valid \`target_handle\` literal-union for a given Component instance type. */
export type PortOf<T extends ComponentType> = (typeof COMPONENT_PORTS)[T][number];
`;
writeFileSync(join(nodesDir, "_base/_base.types.ts"), baseTypesContent);

// _REGISTRY.ts
const lines: string[] = [
  "// GENERATED — edit node-components.json, then run `bun run codegen`",
  'import type { NodeTypes } from "@xyflow/react";',
  'import type { ComponentType } from "./_base/_base.types";',
  'import type { NodeHostAdapter } from "./_base/host-adapter";',
  "",
];

for (const e of entries) {
  const kebab = toKebabCase(e.name);
  const fp = `./${kebab}/${kebab}`;
  lines.push(`import { ${e.name} } from "${fp}";`);
  lines.push(`import { defaults as ${e.name}Defaults } from "${fp}.schema";`);
  if (entryUsesAdapter(e)) {
    lines.push(`import { adapter as ${e.name}Adapter } from "${fp}";`);
  }
}

lines.push(
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
  "export type NodeRegistryEntry = {",
  "  component: unknown;",
  "  defaults: NodeDefaults;",
  "  adapter?: NodeHostAdapter;",
  "};",
  "",
  "export const NODE_REGISTRY = {",
);

for (const e of entries) {
  const adapterField = entryUsesAdapter(e) ? `${e.name}Adapter` : "undefined";
  lines.push(
    `  ${e.name}: { component: ${e.name}, defaults: ${e.name}Defaults as NodeDefaults, adapter: ${adapterField} },`,
  );
}

lines.push(
  "} satisfies Record<ComponentType, NodeRegistryEntry>;",
  "",
  "// ReactFlow compatibility — derived from NODE_REGISTRY",
  "export const NODE_TYPES = {",
);

for (const e of entries) {
  lines.push(`  ${e.name},`);
}

lines.push("} as const satisfies NodeTypes & Record<ComponentType, unknown>;", "");

writeFileSync(join(nodesDir, "_REGISTRY.ts"), lines.join("\n"));

console.log("✓ Generated _base/_base.types.ts");
console.log("✓ Generated _REGISTRY.ts");
