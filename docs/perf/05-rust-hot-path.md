# Rust hot path: emit, route, receive

The three paths that run at sensor sample rate — a component emitting, the
router planning its fan-out, and the Firmata codec consuming a serial read.
Everything here is inside `crates/microflow-core`, sans-IO, single-threaded.

## Emit: one allocation per (component, handle), ever

`ComponentBase::send` (`crates/microflow-core/src/runtime/component.rs:255`) is
the only place a `ComponentEvent` is built by a node. Its two `Arc<str>` fields
are both clones of an `Arc` the component already owns:

- `source` clones `ComponentBase::id`.
- `source_handle` comes from `ComponentBase::interned`
  (`component.rs:270`), which keeps one `Arc<str>` per handle in
  `ComponentBase::handles` (`component.rs:207`) and clones it thereafter.

The cache is bounded by the impl's declared Emit set — `Component::emits`
(`component.rs:52`) is a compile-checked `&'static [&'static str]` per ADR-0007
— so it is a handful of entries and the lookup is a linear scan. A component
that emits a handle outside its declared set still works; it just costs one
extra entry.

`value.into_owned()` in `send` is a move on the `Cow::Owned` path
(`emit_with_value`) and a clone on the `Cow::Borrowed` path (`emit`, which
borrows `self.value`). The clone is structural: `ComponentEvent::value` is an
owned `ComponentValue`, so a borrowed value cannot be handed to the sink
without one. Removing it means changing that field's type in
`runtime/value.rs`, which is part of the host-facing `Effects` contract.

**Invariants**
- `send` must stay the single construction site for node-emitted events, or the
  interning is bypassed.
- `handles` is per component instance. Do not promote it to a process-wide
  table: the core is `Rc`-based and single-threaded by design, and a global
  would outlive flow updates.
- Handle strings are values, not identities. `interned` compares by content, so
  two spellings of the same handle collapse to one entry.

## Route: two indexes, no edge scans

`FlowRouter` (`router.rs:119`) holds no edge list. `set_edges`
(`router.rs:138`) builds two indexes and drops the `Vec<FlowEdge>`:

- `edge_map: EdgeMap<EdgeTarget>` (`router.rs:121`) — `(source, source_handle)`
  → the targets that pair feeds. Read once per routed event.
- `input_map: EdgeMap<Arc<str>>` (`router.rs:124`) — `(target, target_handle)`
  → the source ids feeding that input, in edge order. Read by
  `deliver_snapshot` (`router.rs:212`) for aggregating targets.

Both lookups are O(1) in the edge count; the work per event is proportional to
fan-out, and per snapshot to fan-in. `deliver_snapshot` preserves edge insertion
order, which is the order the aggregating node sees its `Array` inputs in.

`EdgeMap` (`router.rs:77`) keys on an `FxHasher` `u64` of the two strings with a
`0` separator (`router.rs:87`), so the hot path never hashes strings twice.
`FxHasher` is a speed hash and can collide, so each bucket is a `Vec<Entry<T>>`
(`router.rs:63`) storing its own `(a, b)` pair; `insert` (`router.rs:95`) and
`get` (`router.rs:105`) confirm the pair before touching the items. A collision
therefore costs one extra entry in a bucket and one extra comparison — never a
delivery to another node's targets. `hash_collision_does_not_deliver_to_the_wrong_target`
in the module's tests pins this by planting a foreign entry in a bucket.

**Invariants**
- Any new lookup on this map must compare the stored pair. Keying on the hash
  alone reintroduces a silent mis-wiring, which presents as a flow bug and not
  as a crash.
- `set_edges` is the only writer; it clears both indexes first, so they cannot
  drift apart.
- The two indexes must be filled from the same edge in the same iteration.

## Drain: one event, one clone

`FlowExecutor::finish` (`runtime/mod.rs:710`) pops each emitted event, hands it
to `process_event` by reference (`mod.rs:797`), then moves the event into
`Effects::component_events` (`mod.rs:744`) if its handle is not
`_`-prefixed. The move happens after dispatch; the cascade a dispatch triggers
is drained on later iterations, so `component_events` stays in drain order.

`Effects::component_events` is consumed — the desktop host reads it in
`apps/web/src-tauri/src/runtime/host.rs` and the browser host forwards it to the
UI — so its contents are contract, not debug output.

The source `set_value` echo (`mod.rs:826`) compares before writing and clones
only when the stored value actually differs. `Component::set_value` has no
overrides; it writes `base_mut().value` and nothing else, so the skip is
observationally identical.

**Invariants**
- `process_event` takes `&ComponentEvent`. Taking it by value forces a clone
  back into the loop.
- If `Component::set_value` ever gains an override with side effects, the
  equality guard at `mod.rs:826` has to go with it.

## Receive: cursor buffer, resumable sysex scan

`FirmataClient` keeps received bytes in `rx` with a read cursor `rx_pos`
(`firmata/mod.rs:145`). `parse_one` (`firmata/mod.rs:391`) reads at `rx_pos` and
consumes with `consume` (`firmata/mod.rs:385`), which only advances the cursor —
consuming a message is O(1). `feed` (`firmata/mod.rs:347`) calls `compact`
(`firmata/mod.rs:370`) once when parsing stops, so the buffer remainder moves at
most once per transport read regardless of how many messages that read carried.

Sysex framing scans for `END_SYSEX` from `rx_pos + sysex_scanned`
(`firmata/mod.rs:447`); on an incomplete frame `sysex_scanned` records how far
the scan got, so a frame spread over several reads is walked once in total.
`consume` resets it. The frame is parsed in place: `rx` is moved aside with
`std::mem::take` (`firmata/mod.rs:457`) so `parse_sysex` can hold `&mut self`
while borrowing the frame, then put straight back. No per-frame copy.

`pending_bytes` (`firmata/mod.rs:363`) reports `rx.len() - rx_pos`, i.e. the
unconsumed stream, which is what callers and tests mean by "buffered".

`feed` returns the `Vec<Message>` it parsed. `crates/microflow-firmata-wasm/src/lib.rs`
consumes that list; `FlowExecutor::feed_bytes` (`runtime/mod.rs:428`) does not —
it diffs the client's cached state instead — and pays one small `Vec` per read.

**Invariants**
- `rx_pos` is an index into `rx`, not into the pending slice. Anything reading
  `rx` directly must offset by it.
- `sysex_scanned` is relative to `rx_pos`, so `compact` does not have to adjust
  it; every cursor advance must go through `consume` to keep that true.
- `parse_sysex` must not touch `rx` — it runs while `rx` is moved out.
- Framing must not depend on read boundaries. `chunking_never_changes_the_parse`
  in `crates/microflow-core/src/firmata/tests.rs` replays one stream at every
  chunk size and asserts an identical message sequence and final state.
