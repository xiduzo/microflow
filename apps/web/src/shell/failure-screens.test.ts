import { afterEach, describe, expect, test } from "bun:test";
import { configureErrorReporting, reportError, type ErrorReport } from "@/lib/report-error";
import { failureDetails } from "./failure-screens";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("failureDetails", () => {
  test("the reference on screen is the fingerprint the report carried", () => {
    const remote: ErrorReport[] = [];
    restore = configureErrorReporting({ local: [], remote: [(r) => remote.push(r)] });
    const error = new TypeError("node config broke");

    reportError(error, { source: "route-boundary" });
    const details = failureDetails(error, "route-boundary");

    expect(details.reference).toBe(remote[0]!.fingerprint);
    expect(details.message).toBe("node config broke");
  });

  test("falls back to a generic message for thrown non-errors", () => {
    expect(failureDetails("just a string", "app-boundary").message).toBe("An unexpected error occurred.");
    expect(failureDetails(new Error(""), "app-boundary").message).toBe("An unexpected error occurred.");
  });
});
