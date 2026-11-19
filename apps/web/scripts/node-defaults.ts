// The text of `node-defaults.generated.json`: what the editor writes into a
// node's `data`, per Component Catalog entry, read off the entry's own zod
// schema —
//
// - `defaults`: the settings a newly placed node carries (`NODE_CATALOG[type]
//   .defaults` without its presentation keys — label, description, icon, group,
//   tags — which no config reads, so a copy edit does not touch this file);
// - `variants`: for a schema that is a discriminated union (Piezo's buzz/song),
//   each member's `select` (the literal fields that pick it) and its own parsed
//   `defaults`;
// - `options`: every value of every enum field, as a patch on `defaults` (and,
//   in a union, on top of its variant's `select`).
//
// It is the TypeScript half of the Catalog Parity Guard's config check
// (`src-tauri/tests/catalog_parity.rs`): Rust feeds all of it through its
// node-config resolution, so a default or an option the runtime or the sketch
// cannot read, or reads differently, fails CI. `codegen-node-registry.ts`
// writes the file; `node-defaults.test.ts` asserts the committed copy is
// current.

import type { ZodType } from "zod";

type Data = Record<string, unknown>;

/** The catalog shape this needs: each entry's default `data` and its schema. */
type Catalog = Record<string, { defaults: unknown; schema: ZodType }>;

type Variant = { select: Data; defaults: Data };
type EntryDefaults = { defaults: Data; variants: Variant[]; options: Data[] };

/** What a node's `data` carries for the canvas and the node picker. */
const PRESENTATION = new Set(["label", "description", "icon", "group", "tags"]);

/** `data` without its presentation keys. */
const settingsOf = (data: unknown): Data =>
  Object.fromEntries(Object.entries(data as Data).filter(([key]) => !PRESENTATION.has(key)));

// The schema internals this reads: zod 4's `def` (`type` plus, per type,
// `innerType`, `options`, `shape`, `entries`, `values`).
type Def = {
  type: string;
  innerType?: Schema;
  options?: Schema[];
  shape?: Record<string, Schema>;
  entries?: Record<string, string | number>;
  values?: unknown[];
};
type Schema = ZodType & { def: Def };

const WRAPPERS = new Set(["default", "prefault", "optional", "nullable", "catch", "readonly"]);

/** The schema inside any default / optional / catch wrapping. */
function unwrap(schema: Schema): Schema {
  let inner = schema;
  while (WRAPPERS.has(inner.def.type) && inner.def.innerType) inner = inner.def.innerType;
  return inner;
}

/** The object schemas a node's `data` may match: one, or a union's members. */
function members(schema: Schema): Schema[] {
  const inner = unwrap(schema);
  if (inner.def.type === "object") return [inner];
  if (inner.def.type === "union") return (inner.def.options ?? []).flatMap(members);
  return [];
}

/** `instance` names the catalog entry; it is never a setting. */
const settings = (member: Schema) =>
  Object.entries(member.def.shape ?? {}).filter(([key]) => key !== "instance");

/** The single-valued literal fields of a union member: what selects it. */
function selectOf(member: Schema): Data {
  const select: Data = {};
  for (const [key, field] of settings(member)) {
    const { type, values } = unwrap(field).def;
    if (type === "literal" && values?.length === 1) select[key] = values[0];
  }
  return select;
}

/** One patch per value of every enum field of `member`, on top of `select`. */
function optionsOf(member: Schema, select: Data): Data[] {
  const options: Data[] = [];
  for (const [key, field] of settings(member)) {
    const { type, entries } = unwrap(field).def;
    if (type !== "enum" || !entries) continue;
    for (const value of Object.values(entries)) options.push({ ...select, [key]: value });
  }
  return options;
}

function entryDefaults(entry: Catalog[string]): EntryDefaults {
  const defaults = settingsOf(entry.defaults);
  const all = members(entry.schema as Schema);
  if (all.length <= 1) {
    return { defaults, variants: [], options: all.flatMap((member) => optionsOf(member, {})) };
  }
  const variants = all.map((member) => {
    const select = selectOf(member);
    // A member with a required field has no defaults of its own beyond `select`.
    const parsed = member.safeParse(select);
    return { select, defaults: parsed.success ? settingsOf(parsed.data) : select };
  });
  const options = all.flatMap((member, i) => [
    variants[i]!.select,
    ...optionsOf(member, variants[i]!.select),
  ]);
  return { defaults, variants, options };
}

/** Entries sorted by name, so the file does not depend on catalog order. */
export function nodeDefaultsJson(catalog: Catalog): string {
  const byName = Object.fromEntries(
    Object.keys(catalog)
      .sort()
      .map((name) => [name, entryDefaults(catalog[name]!)]),
  );
  return `${JSON.stringify(byName, null, 2)}\n`;
}
