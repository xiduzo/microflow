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
  return {
    doc,
    writes,
    get stored() { return stored; },
    /** A peer's edit: lands in the doc without going through this committer. */
    remote(data: Record<string, unknown>) { stored = { ...stored, ...data }; return stored; },
  };
}

/** Manual scheduler standing in for requestAnimationFrame. */
function makeScheduler() {
  const queue: (() => void)[] = [];
  return {
    schedule: (run: () => void) => queue.push(run),
    flush: () => { for (const run of queue.splice(0)) run(); },
  };
}

function make(
  initial: Record<string, unknown> = {},
  readOnly = false,
  defaults: Record<string, unknown> = {},
) {
  const fake = makeDoc(initial);
  const { schedule, flush } = makeScheduler();
  // Seeded the way `useNodeControls` seeds it: from the doc data at mount.
  const committer = createNodeDataCommitter({
    doc: fake.doc,
    nodeId: "n1",
    readOnly,
    schedule,
    initial: { doc: initial, controls: defaults },
  });
  return { committer, fake, flush };
}

describe("createNodeDataCommitter — opening a node", () => {
  it("writes nothing when the controls mount with the doc's values", () => {
    const { committer, fake, flush } = make({ label: "a", speed: 1 });
    // The mount commit: Leva reports its starting values, which are the doc's.
    committer.commit({ label: "a", speed: 1 });
    flush();
    expect(fake.writes).toEqual([]);
  });

  it("writes nothing for a control default the doc does not hold", () => {
    // An older node, from before the `speed` control existed: Leva shows its
    // default, the doc has no key. Opening the node is not an edit.
    const { committer, fake, flush } = make({ label: "a" }, false, { label: "a", speed: 1 });
    committer.commit({ label: "a", speed: 1 });
    flush();
    expect(fake.writes).toEqual([]);
  });

  it("still writes the first real change after mount", () => {
    const { committer, fake, flush } = make({ label: "a", speed: 1 });
    committer.commit({ label: "a", speed: 1 });
    flush();
    committer.commit({ label: "a", speed: 2 });
    flush();
    expect(fake.writes).toEqual([{ speed: 2 }]);
  });
});

describe("createNodeDataCommitter — a key leaving the doc", () => {
  it("resets the control to its default when undo removes the key the first edit added", () => {
    // The doc has no `speed`; Leva shows the default 1.
    const { committer, fake, flush } = make({ label: "a" }, false, { label: "a", speed: 1 });
    committer.commit({ label: "a", speed: 1 }); // mount
    flush();
    committer.commit({ label: "a", speed: 2 }); // the first edit adds the key
    flush();
    expect(fake.writes).toEqual([{ speed: 2 }]);

    // Ctrl+Z: the key is gone from the doc again.
    const patch = committer.reconcile({ label: "a" }, { label: "a", speed: 2 });
    expect(patch).toEqual({ speed: 1 }); // the control shows what the runtime will use

    committer.commit({ label: "a", speed: 1 }); // Leva replays the reset
    flush();
    expect(fake.writes).toHaveLength(1); // not written back

    // Round trip: entering 2 again is a real edit and reaches the doc.
    committer.commit({ label: "a", speed: 2 });
    flush();
    expect(fake.writes).toEqual([{ speed: 2 }, { speed: 2 }]);
  });

  it("leaves a control at its default alone while the doc lacks the key", () => {
    const { committer } = make({ label: "a" }, false, { label: "a", speed: 1 });
    committer.commit({ label: "a", speed: 1 });
    expect(committer.reconcile({ label: "b" }, { label: "a", speed: 1 })).toEqual({ label: "b" });
  });
});

describe("createNodeDataCommitter — pending edits versus a doc change", () => {
  it("does not replay a peer's value over a key the user has an unflushed edit on", () => {
    const { committer, fake, flush } = make({ label: "a", speed: 1 });
    committer.commit({ label: "typed", speed: 1 }); // the user's keystroke, not flushed yet

    // A peer's edit lands in the same frame.
    const docData = fake.remote({ label: "peer", speed: 5 });
    const patch = committer.reconcile(docData, { label: "typed", speed: 1 });

    // `label` is the user's pending intent: keep it. `speed` is untouched
    // locally: take the peer's.
    expect(patch).toEqual({ speed: 5 });
    flush();
    // Only the edited key is written — the stale `speed: 1` the pending values
    // still carried must not clobber the peer's `5`.
    expect(fake.writes).toEqual([{ label: "typed" }]);
    expect(fake.stored).toEqual({ label: "typed", speed: 5 });
  });
});

describe("createNodeDataCommitter", () => {
  it("writes the changed control values as a per-field patch through updateNodeData", () => {
    const { committer, fake, flush } = make({ label: "old", speed: 1 });
    committer.commit({ label: "new", speed: 1 });
    flush();
    // Only the field that changed: an unchanged key re-sent would overwrite a
    // peer's concurrent edit to it (ADR-0019).
    expect(fake.writes).toEqual([{ label: "new" }]);
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
    expect(fake.writes).toHaveLength(0); // the mount commit writes nothing

    // A peer renames the node; the doc data shifts under the controls.
    const patch = committer.reconcile(
      { label: "remote", speed: 1, icon: "zap" },
      { label: "a", speed: 1 },
    );
    expect(patch).toEqual({ label: "remote" });

    // The hook replays the patch into Leva, whose new values trigger a commit.
    committer.commit({ label: "remote", speed: 1 });
    flush();
    expect(fake.writes).toHaveLength(0); // suppressed — nothing new to say
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
