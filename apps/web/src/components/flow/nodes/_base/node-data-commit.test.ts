import { describe, expect, it } from "bun:test";
import { createNodeDataCommitter, type NodeDataDoc } from "./node-data-commit";

/** Patch-merge fake with `FlowDocument.updateNodeData`'s semantics: only the
 *  keys present are written, everything else on the node survives (ADR-0019). */
function makeDoc(initial: Record<string, unknown> = {}) {
  const writes: Record<string, unknown>[] = [];
  let stored = { ...initial };
  const doc: NodeDataDoc = {
    updateNodeData(_nodeId, data) {
      writes.push(data);
      stored = { ...stored, ...data };
    },
  };
  return { doc, writes, get stored() { return stored; } };
}

/** Manual scheduler standing in for requestAnimationFrame. */
function makeScheduler() {
  const queue: (() => void)[] = [];
  return {
    schedule: (run: () => void) => queue.push(run),
    flush: () => { for (const run of queue.splice(0)) run(); },
  };
}

function make(initial: Record<string, unknown> = {}, readOnly = false) {
  const fake = makeDoc(initial);
  const { schedule, flush } = makeScheduler();
  const committer = createNodeDataCommitter({ doc: fake.doc, nodeId: "n1", readOnly, schedule });
  return { committer, fake, flush };
}

describe("createNodeDataCommitter", () => {
  it("writes control values as a per-field patch through updateNodeData", () => {
    const { committer, fake, flush } = make({ label: "old", speed: 1 });
    committer.commit({ label: "new", speed: 1 });
    flush();
    expect(fake.writes).toEqual([{ label: "new", speed: 1 }]);
  });

  it("coalesces scheduled commits so only the latest values are written", () => {
    const { committer, fake, flush } = make();
    committer.commit({ label: "a" });
    committer.commit({ label: "ab" });
    committer.commit({ label: "abc" });
    flush();
    expect(fake.writes).toEqual([{ label: "abc" }]);
  });

  it("suppresses the echo of a remote edit — no write-back loop", () => {
    const { committer, fake, flush } = make({ label: "a", speed: 1 });
    committer.commit({ label: "a", speed: 1 });
    flush();
    expect(fake.writes).toHaveLength(1);

    // A peer renames the node; the doc data shifts under the controls.
    const patch = committer.reconcile(
      { label: "remote", speed: 1, icon: "zap" },
      { label: "a", speed: 1 },
    );
    expect(patch).toEqual({ label: "remote" });

    // The hook replays the patch into Leva, whose new values trigger a commit.
    committer.commit({ label: "remote", speed: 1 });
    flush();
    expect(fake.writes).toHaveLength(1); // suppressed — nothing new to say
  });

  it("reconcile reports nothing for the echo of our own write", () => {
    const { committer, flush } = make({ label: "a" });
    committer.commit({ label: "typed" });
    flush();
    // The write comes back around as fresh doc data (with undeclared extras).
    const patch = committer.reconcile({ label: "typed", icon: "zap" }, { label: "typed" });
    expect(patch).toBeNull(); // no `set` → no stomping the input mid-typing
  });

  it("is a no-op on a read-only session, forceCommit included", () => {
    const { committer, fake, flush } = make({ label: "a" }, true);
    committer.commit({ label: "changed" });
    flush();
    committer.forceCommit({ code: "x" });
    expect(fake.writes).toHaveLength(0);
  });

  it("preserves a data field the control schema does not declare", () => {
    // Deliberate: undeclared fields (a Function node's `code`, say) are owned
    // by forceCommit/other writers — a controls commit must not touch them.
    const { committer, fake, flush } = make({ label: "a", code: "return x;" });
    committer.commit({ label: "renamed" });
    flush();
    expect(fake.writes).toEqual([{ label: "renamed" }]); // patch has no `code` key
    expect(fake.stored.code).toBe("return x;"); // survives the merge
    // …and reconcile never replays it into the controls either.
    expect(committer.reconcile({ label: "renamed", code: "changed" }, { label: "renamed" })).toBeNull();
  });

  it("lands a forceCommit immediately, ahead of the scheduled controls commit", () => {
    const { committer, fake, flush } = make({ label: "a" });
    committer.commit({ label: "a" });
    committer.forceCommit({ code: "new code" }); // e.g. from a Leva onChange
    flush();
    expect(fake.writes[0]).toEqual({ code: "new code" });
    expect(fake.stored).toEqual({ label: "a", code: "new code" });
  });

  it("replays an undo into the controls, then drops the replay's commit", () => {
    const { committer, fake, flush } = make({ label: "a" });
    committer.commit({ label: "b" });
    flush();
    // Undo reverts the doc to "a".
    const patch = committer.reconcile({ label: "a" }, { label: "b" });
    expect(patch).toEqual({ label: "a" });
    committer.commit({ label: "a" });
    flush();
    expect(fake.writes).toHaveLength(1); // the redo stack is not polluted
  });
});
