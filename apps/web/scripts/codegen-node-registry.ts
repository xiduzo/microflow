import manifest from "../node-components.json";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodesDir = join(__dirname, "../src/components/flow/nodes");

function toKebabCase(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

function getFilePath(name: string, file?: string): string {
  if (file) return file;
  const kebab = toKebabCase(name);
  return `./${kebab}/${kebab}`;
}

const { components } = manifest;

// _base/_base.types.ts
const typeNames = components.map((c) => `  "${c.name}"`).join(",\n");
const baseTypesContent = `// GENERATED — edit node-components.json, then run \`bun run codegen\`

export const COMPONENT_TYPES = [
${typeNames},
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export function isComponentType(value: string): value is ComponentType {
  return COMPONENT_TYPES.includes(value as ComponentType);
}
`;
writeFileSync(join(nodesDir, "_base/_base.types.ts"), baseTypesContent);

// _REGISTRY.ts
const lines: string[] = [
  "// GENERATED — edit node-components.json, then run `bun run codegen`",
  'import type { NodeTypes } from "@xyflow/react";',
  'import type { ComponentType } from "./_base/_base.types";',
  "",
];

for (const c of components) {
  const fp = getFilePath(c.name, (c as { file?: string }).file);
  lines.push(`import { ${c.name} } from "${fp}";`);
  lines.push(`import { defaults as ${c.name}Defaults } from "${fp}.schema";`);
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
  "};",
  "",
  "export const NODE_REGISTRY = {",
);

for (const c of components) {
  lines.push(
    `  ${c.name}: { component: ${c.name}, defaults: ${c.name}Defaults as NodeDefaults },`,
  );
}

lines.push(
  "} satisfies Record<ComponentType, NodeRegistryEntry>;",
  "",
  "// ReactFlow compatibility — derived from NODE_REGISTRY",
  "export const NODE_TYPES = {",
);

for (const c of components) {
  lines.push(`  ${c.name},`);
}

lines.push(
  "} as const satisfies NodeTypes & Record<ComponentType, unknown>;",
  "",
);

writeFileSync(join(nodesDir, "_REGISTRY.ts"), lines.join("\n"));

console.log("✓ Generated _base/_base.types.ts");
console.log("✓ Generated _REGISTRY.ts");
