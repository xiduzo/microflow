import { describe, expect, test } from "bun:test";
import { resolveNodeData } from "@/nodes/node-data-resolver";
import { type Data, numberDefaults, rangeDefaults, textDefaults } from "./compare.schema";
import { comparisonSummary } from "./compare.summary";

const summary = (data: Record<string, unknown>) => comparisonSummary(data as unknown as Data);

// A node as the settings panel leaves it when a validator is picked and its
// setting is not edited: the validator and its first option, nothing else.
describe("a Compare node that does not hold its validator's setting", () => {
  test("a range says the schema's default bounds", () => {
    expect(rangeDefaults.range).toEqual({ min: 0, max: 100 });
    expect(summary({ validator: "range", subValidator: "between" })).toBe("is between 0 and 100");
  });

  test("a range with one bound says the schema's default for the other", () => {
    expect(summary({ validator: "range", subValidator: "outside", range: { min: 20 } })).toBe(
      "is outside 20 and 100",
    );
  });

  test("a number says the schema's default number", () => {
    expect(numberDefaults.number).toBe(0);
    expect(summary({ validator: "number", subValidator: "greater than" })).toBe("is greater than 0");
  });

  test("a text says the schema's default text", () => {
    expect(textDefaults.text).toBe("");
    expect(summary({ validator: "text", subValidator: "including" })).toBe('is including ""');
  });

  // Ask AI and the flow file codec read a node through its schema, which
  // falls back to the boolean validator for a node it refuses.
  test("a text stays a text validator when it is read through the schema", () => {
    const resolved = resolveNodeData("Compare", { validator: "text", subValidator: "including" });
    expect(resolved.ok && resolved.data).toMatchObject({ validator: "text", subValidator: "including", text: "" });
  });

  test("a range reads through the schema as the bounds its face says", () => {
    const resolved = resolveNodeData("Compare", { validator: "range", subValidator: "between" });
    expect(resolved.ok && resolved.data).toMatchObject({ range: rangeDefaults.range });
  });
});

describe("a Compare node that holds its setting", () => {
  test("says what it holds", () => {
    expect(summary({ validator: "boolean", subValidator: "true" })).toBe("boolean");
    expect(summary({ validator: "oddEven", subValidator: "odd" })).toBe("is odd");
    expect(summary({ validator: "number", subValidator: "less than", number: 1500 })).toBe("is less than 1,500");
    expect(summary({ validator: "range", subValidator: "between", range: { min: 100, max: 500 } })).toBe(
      "is between 100 and 500",
    );
    expect(summary({ validator: "text", subValidator: "equal to", text: "on" })).toBe('is equal to "on"');
  });
});
