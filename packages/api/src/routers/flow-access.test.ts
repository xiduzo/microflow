import { describe, expect, test } from "bun:test";
import {
  assertFlowRole,
  resolveFlowRole,
  type FlowRole,
} from "./flow-role";

const OWNER = "user-owner";
const OTHER = "user-other";
const flowRecord = { ownerId: OWNER };

describe("resolveFlowRole", () => {
  test("owner wins regardless of collaborator role", () => {
    expect(resolveFlowRole(flowRecord, OWNER, undefined)).toBe("owner");
    expect(resolveFlowRole(flowRecord, OWNER, "viewer")).toBe("owner");
  });

  test("non-owner gets their collaborator role, or null", () => {
    expect(resolveFlowRole(flowRecord, OTHER, "editor")).toBe("editor");
    expect(resolveFlowRole(flowRecord, OTHER, "viewer")).toBe("viewer");
    expect(resolveFlowRole(flowRecord, OTHER, undefined)).toBeNull();
    expect(resolveFlowRole(flowRecord, OTHER, null)).toBeNull();
  });
});

describe("assertFlowRole access matrix", () => {
  const cases: Array<[FlowRole | null, FlowRole, boolean]> = [
    // [actual role, required role, allowed]
    ["owner", "owner", true],
    ["owner", "editor", true],
    ["owner", "viewer", true],
    ["editor", "owner", false],
    ["editor", "editor", true],
    ["editor", "viewer", true],
    ["viewer", "owner", false],
    ["viewer", "editor", false],
    ["viewer", "viewer", true],
    [null, "viewer", false],
    [null, "editor", false],
    [null, "owner", false],
  ];

  test.each(cases)("role=%p minRole=%p → allowed=%p", (role, minRole, allowed) => {
    if (allowed) {
      expect(assertFlowRole(role, minRole)).toBe(role as FlowRole);
    } else {
      expect(() => assertFlowRole(role, minRole)).toThrow("Access denied");
    }
  });
});
