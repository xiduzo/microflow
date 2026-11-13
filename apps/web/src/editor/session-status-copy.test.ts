import { describe, expect, test } from "bun:test";
import type { FlowSessionStatus } from "@/session";
import { describeSessionStatus } from "./session-status-copy";

const base: FlowSessionStatus = {
  kind: "saved",
  readOnly: false,
  unsyncedChanges: 0,
  lastSavedAt: null,
  accessLost: null,
  serverRestarting: false,
  localError: null,
};

const describe_ = (patch: Partial<FlowSessionStatus>) => describeSessionStatus({ ...base, ...patch });

describe("session status copy", () => {
  test("a healthy local flow shows nothing", () => {
    expect(describe_({ kind: "local" })).toBeNull();
  });

  test("a local flow that is not being stored says so, as an error", () => {
    expect(describe_({ kind: "local-unsaved", localError: "IndexedDB is blocked." })).toMatchObject({
      label: "Not saving locally",
      tone: "bad",
    });
  });

  test("offline counts unsynced changes", () => {
    expect(describe_({ kind: "offline", unsyncedChanges: 1 })?.label).toBe("Offline · 1 unsynced change");
    expect(describe_({ kind: "offline", unsyncedChanges: 3 })?.label).toBe(
      "Offline · 3 unsynced changes",
    );
    expect(describe_({ kind: "offline" })?.canRetry).toBe(true);
  });

  test("a server restart is reconnecting, not an error", () => {
    expect(describe_({ kind: "offline", serverRestarting: true })).toMatchObject({
      label: "Server restarting",
      tone: "busy",
      canRetry: false,
    });
  });

  test("access lost names who refused", () => {
    const label = (reason: string, code: number) =>
      describe_({ kind: "access-lost", readOnly: true, accessLost: { reason, code } })?.label;
    expect(label("Unauthorized", 1008)).toBe("Signed out");
    expect(label("Forbidden", 1008)).toBe("No access"); // an older server
    expect(label("Forbidden", 4403)).toBe("No access");
    expect(label("Access revoked", 4401)).toBe("Access removed");
    expect(label("Flow not found", 4404)).toBe("Flow deleted");
  });

  test("retry is offered only where it can help", () => {
    const retry = (code: number) =>
      describe_({ kind: "access-lost", readOnly: true, accessLost: { reason: "", code } })?.canRetry;
    expect(retry(4404)).toBe(false);
    expect(retry(4401)).toBe(false);
    expect(retry(1008)).toBe(true);
  });
});
