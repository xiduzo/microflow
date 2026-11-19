# ADR-0033 — One node-config resolution; the editor's `data` shape is the contract

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander

> **Decision:** a Node's `data` becomes its config in exactly one step,
> `microflow_core::config::resolve`, and both halves of the engine go through
> it: the live runtime when it builds the Node, every Arduino emitter before it
> writes C++. A `data` that cannot be read is an **unreadable config** on both
> sides: the Node is not running live, and no Sketch is generated on export.
> Neither side substitutes defaults. The shape the editor writes is the
> contract; the Catalog Parity Guard feeds everything the editor can write
> through the same step, for every Component Catalog entry, so a disagreement
> fails CI.

## Context

[ADR-0006](0006-rehost-runtime-on-core.md) gave interpret and emit one config
struct per Node, and [ADR-0026](0026-node-code-colocated-per-node.md) put it
next to both readers. The struct was shared; the *reading* of it was not. The
`ComponentRegistry` deserialized `data` and failed the Node on an error. The
emitters fell back to `Default` at 39 call sites
(`serde_json::from_value(node.data.clone()).unwrap_or_default()`), and Sensor,
Matrix and Function read ad hoc JSON with hand-mirrored defaults. So one flow
had two meanings: a Led whose `pin` was `"left"` did not run live, and exported
as a working sketch on pin 13 — a pin its Author never picked.

The same split showed in numbers. The editor's numeric inputs store JSON
numbers, and a dragged or pasted value can carry a fraction. Every integer
field refused one (a Proximity `freq` of `25.2`), so a value the editor itself
had written stopped the Node. A pin of `13.4` was truncated to 13. Sensor and
Proximity kept their pin as a string each half parsed for itself, so a label
that names no pin was `A0` in the sketch and pin 0 live.

Nothing checked the two languages against each other either. A node's settings
are authored by its zod schema in TypeScript and read by a hand-written Rust
struct. A Rust default that differs from the schema's, an enum option spelled
differently, or a field missing `rename_all = "camelCase"` (which never errors:
the field silently keeps its default) failed no test. The first run of the
config guard failed on Pixel's pin and colour order, Mqtt's
`direction`, Compare's `oddEven` and Compare's range bounds.

## Decision

**D1 — One resolution step.** `config::resolve::<C>(data)`
(`crates/microflow-core/src/config/mod.rs`) reads a Node's `data` into its
config `C`. It is the only reader. The registry's factory calls it for
interpret (`runtime/registry.rs`); every emitter that has settings calls it by
name, `resolve::<LedConfig>(&node.data)?`, for emit. What a *missing* field
means stays the config's own business (its serde defaults), and fields the
config does not know are ignored; `resolve` refuses only a `data` whose present
fields do not fit.

**D2 — Unreadable is one fact, reported per half, never defaulted.** The error
is `UnreadableConfig`. It displays as the setting and the reason:
`pin: invalid pin: left`, `pins.red: pin out of range: 300`. The text is shown
in the editor and quotes whatever the Flow holds, so it is bounded: the
setting's path stays whole, a quoted value is cut after 40 characters and the
reason as a whole after 240 (`MAX_QUOTED`, `MAX_REASON`). Interpret maps it
to `RuntimeError::ConfigDeserialize`, which Node health shows as "Not running:
its settings could not be read (…)". Emitters return
`Result<NodeEmission, UnreadableConfig>`; generation turns each into an
error-severity `ValidationProblem` (`codegen::validate::unreadable_config`),
reports all of them together with the flow's other problems, and returns no
sketch. `pin_demands` has nothing to judge for such a Node.

**D3 — The setting is named on the failure path only.** Serde says what is
wrong but not where. `resolve` finds the path (`pins.red`, `shapes[1][1]`) by
re-reading copies of `data` with one setting taken out, and only after a read
has failed. When two settings fail for the same reason, or the culprit sits
inside a fixed-length entry, it names what it can and leaves the reason alone.
The number of re-reads stays small whatever `data` holds: one per field of an
object, none for an object of more than 64 fields (`MAX_FIELDS_SEARCHED`, more
than any config has settings), and for a list as many as halving it to its
first unreadable element takes (13 for 5,000 entries).

**D4 — How a number is read is shared, in `config::serde_utils`.** A
whole-number setting (`deserialize_whole`) rounds a JSON number to the nearest
whole number, halves away from zero, and refuses a value its type cannot hold;
nothing is clamped or wrapped. A pin (`deserialize_pin_u8`) is a name: `13`,
`13.0` and `"13"` are pin 13, `13.4` is refused. An analog pin
(`deserialize_analog_pin`) is `"A0"`-style or a pin number, held as a
`PinLabel` that each half resolves against its own board.

**D5 — The editor's shape wins.** Saved flows already carry what the editor
writes, so a disagreement is fixed in the Rust config. The frontend codegen
reads off every entry's schema what the editor can write — a new node's
defaults, each schema variant's defaults, every option of every enum field —
into `apps/web/node-defaults.generated.json`
(`apps/web/scripts/node-defaults.ts`).

**D6 — The guard is class-wide.** The Catalog Parity Guard
(`apps/web/src-tauri/tests/catalog_parity.rs`,
[ADR-0007](0007-node-wire-interface-emit-contract.md)) reads that file for
every registered entry and fails when: any of it is unreadable by the runtime
or refuses a sketch; an editor default differs from the config's own default
and is not listed, with its reason, in `DELIBERATE_DIFFERENCES`; a config field
is spelled differently from what the editor writes; a fraction or an
out-of-range number in an integer setting does not mean the same to both
halves; or a setting the defaults show nothing of (absent, or inside a list
that starts empty, such as Stepper's `enablePin` or Piezo's `song`) has no
value listed in `HIDDEN_BY_DEFAULT` to check it with. The guard writes each
listed value into the defaults and checks what then shows like any other
setting. Two guards inside core complete it: `nodes/boundaries.rs` fails when an
emitter resolves another config than its runtime is built from, and
`codegen/parity.rs` checks, for every registered type, that settings the
runtime cannot read refuse the sketch too.

**D7 — Regenerating is part of the edit.** `bun run catalog:sync` (in
`apps/web`) runs three steps: bless `wire-interface.generated.json` from Rust,
`bun run codegen`, then the whole guard. A schema edit alone needs
`bun run codegen`; `apps/web/scripts/node-defaults.test.ts` fails on a stale
`node-defaults.generated.json`.

## Considered options

- **Substitute defaults on both sides.** Consistent, but a Node on a pin its
  Author did not pick is worse than a Node that says it is not running.
- **Track the path inside the deserializer** (`serde_path_to_error`). It is
  compiled again for every config; measured, it grew the browser's codegen
  module by a sixth. D3 costs nothing until a read fails.
- **Round a pin, or clamp an out-of-range number.** A pin is not a quantity,
  and a delay of −5 has no nearest value its Author would recognise.

## Consequences

- A flow means the same live and exported, including when it cannot be read.
  One unreadable Node refuses the whole sketch; there is no partial export.
- A new Node gets all of this from its `register` line: the guard walks the
  registry, so no per-node test is written. A Node with a setting its defaults
  hide adds one `HIDDEN_BY_DEFAULT` entry.
- Adding a setting touches two languages and a generated file, and CI fails
  until they agree. `DELIBERATE_DIFFERENCES` fails on an entry that stops
  differing, and `HIDDEN_BY_DEFAULT` on an entry for a setting that is not
  hidden, so neither list can go stale.
- Every `ComponentBuilder::Config` must also be `Serialize`, so the guard can
  read back what a `data` resolved to (`ComponentRegistry::resolved_config`,
  compiled only under the `test-nodes` feature).
- Accepted residue: the guard covers what the schema can enumerate (defaults,
  variants, enum options, numbers in integer settings). A free-form value the
  schema allows and the config refuses — a negative duration typed by hand — is
  found at run time, as Node health.
- Accepted residue: a rounded number runs as the rounded value while the
  editor still shows the fraction.
- Emitters that read no config (Counter, Monitor) and Nodes exported as a
  placeholder comment (Note, Pn532, Music) never refuse a sketch.

## What this does NOT decide

- Generating the zod schema from the Rust config, or the reverse. Both stay
  hand-written; the guard holds them together.
- Whether a value is *sensible* (a minimum above a maximum). `resolve` decides
  only whether `data` can be read.
- Repairing stored or imported `data`. That belongs to the load boundaries
  ([ADR-0041](0041-flow-file-is-a-load-boundary.md) for a flow file) and the editor's Node Data Resolver.
- Whether a pin fits the board: the pin table of
  [ADR-0013](0013-handle-aware-sketch-wiring.md).

## References

- `crates/microflow-core/src/config/mod.rs` — `resolve`, `UnreadableConfig`.
- `crates/microflow-core/src/config/serde_utils.rs` — `deserialize_whole`, `deserialize_pin_u8`, `deserialize_analog_pin`.
- `crates/microflow-core/src/runtime/registry.rs` — the interpret half, `resolved_config`.
- `crates/microflow-core/src/codegen/mod.rs`, `codegen/validate.rs` — `emit_node`, `unreadable_config`.
- `crates/microflow-core/src/nodes/boundaries.rs`, `codegen/parity.rs` — the two guards inside core.
- `apps/web/src-tauri/tests/catalog_parity.rs` — the Catalog Parity Guard, `DELIBERATE_DIFFERENCES`, `HIDDEN_BY_DEFAULT`.
- `apps/web/scripts/node-defaults.ts`, `apps/web/node-defaults.generated.json` — what the editor writes.
- `CONTEXT.md` § Node config resolution, Unreadable config, Catalog Parity Guard.
