import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

import { NODE_CATALOG } from "@/nodes/catalog.generated";
import { nodeDefaultsJson } from "./node-defaults";

// `node-defaults.generated.json` is what the Rust Catalog Parity Guard reads
// (src-tauri/tests/catalog_parity.rs). Rust cannot run a zod schema, so the
// freshness of the committed file is asserted here, where the schemas live.
describe("node-defaults.generated.json", () => {
  it("is current with the node schemas", () => {
    const committed = readFileSync(join(import.meta.dir, "../node-defaults.generated.json"), "utf8");
    const current = nodeDefaultsJson(NODE_CATALOG);
    // A plain boolean keeps a stale file from dumping both copies into the log.
    expect(
      committed === current,
      "node-defaults.generated.json is stale — run `bun run codegen` in apps/web, " +
        "then the Rust guard: `cargo test --manifest-path apps/web/src-tauri/Cargo.toml --test catalog_parity`",
    ).toBe(true);
  });
});

describe("nodeDefaultsJson", () => {
  const read = (schema: z.ZodType, defaults: unknown) =>
    JSON.parse(nodeDefaultsJson({ Node: { defaults, schema } })).Node;

  it("lists every value of every enum field as a patch on the defaults", () => {
    const schema = z.object({
      instance: z.literal("Node").default("Node"),
      pin: z.number().default(13),
      type: z.enum(["NO", "NC"]).default("NO"),
      mode: z.enum(["fast", "slow"]).optional(),
    });
    expect(read(schema, schema.parse({}))).toEqual({
      defaults: { instance: "Node", pin: 13, type: "NO" },
      variants: [],
      options: [{ type: "NO" }, { type: "NC" }, { mode: "fast" }, { mode: "slow" }],
    });
  });

  it("gives each member of a discriminated union its selecting fields and own defaults", () => {
    const buzz = z.object({ type: z.literal("buzz").default("buzz"), frequency: z.number().default(440) });
    const song = z.object({
      type: z.literal("song").default("song"),
      tempo: z.number().default(113),
      feel: z.enum(["straight", "swing"]).default("straight"),
    });
    const schema = z.discriminatedUnion("type", [buzz, song]).default(buzz.parse({}));
    expect(read(schema, schema.parse(undefined))).toEqual({
      defaults: { type: "buzz", frequency: 440 },
      variants: [
        { select: { type: "buzz" }, defaults: { type: "buzz", frequency: 440 } },
        { select: { type: "song" }, defaults: { type: "song", tempo: 113, feel: "straight" } },
      ],
      options: [
        { type: "buzz" },
        { type: "song" },
        { type: "song", feel: "straight" },
        { type: "song", feel: "swing" },
      ],
    });
  });

  it("keeps only the selecting fields of a member that has a required field", () => {
    const boolean = z.object({ validator: z.literal("boolean").default("boolean") });
    const text = z.object({ validator: z.literal("text").default("text"), text: z.string() });
    const schema = z.discriminatedUnion("validator", [boolean, text]);
    expect(read(schema, boolean.parse({})).variants).toEqual([
      { select: { validator: "boolean" }, defaults: { validator: "boolean" } },
      { select: { validator: "text" }, defaults: { validator: "text" } },
    ]);
  });

  it("leaves out the presentation keys, so a copy edit does not make the file stale", () => {
    const buzz = z.object({ type: z.literal("buzz").default("buzz"), tags: z.array(z.string()).default([]) });
    const song = z.object({ type: z.literal("song").default("song"), tags: z.array(z.string()).default([]) });
    const schema = z.discriminatedUnion("type", [buzz, song]);
    const defaults = { type: "buzz", pin: 11, label: "Piezo", description: "…", icon: "BellIcon", group: "express", tags: ["action"] };
    expect(read(schema, defaults)).toEqual({
      defaults: { type: "buzz", pin: 11 },
      variants: [
        { select: { type: "buzz" }, defaults: { type: "buzz" } },
        { select: { type: "song" }, defaults: { type: "song" } },
      ],
      options: [{ type: "buzz" }, { type: "song" }],
    });
  });

  it("sorts entries by name", () => {
    const schema = z.object({});
    const json = nodeDefaultsJson({ Led: { defaults: {}, schema }, Button: { defaults: {}, schema } });
    expect(Object.keys(JSON.parse(json))).toEqual(["Button", "Led"]);
  });
});
