# ADR-0014 — I2C device presets stay TS-authored (not generated from Rust)

- **Status:** accepted (2026-07-03) — records a deliberate non-change
- **Date:** 2026-07-03
- **Deciders:** sander

> **Decision: keep the `I2C_PRESETS` roster hand-authored in TypeScript.** The
> per-device UI defaults an `I2cDevice` node offers when you pick a preset —
> `label`, `address`, `register`, `readLength`, `output`, `freq` — stay in
> `apps/web/.../i2c-device/i2c-device.constants.ts`, NOT moved into a Rust table
> and generated into TS the way ports/emits are (ADR-0007). An architecture review
> proposed that generation; **declined**, with a documented trigger to revisit.

## Context

Adding an I2C device touches two tiers, keyed by the same device id: the TS
`I2C_PRESETS` row (the UX defaults) and — only when the device needs a power-on
sequence — a `crate::config::i2c_device::device_init_writes` arm (+ `effective_register`
/ `is_no_hold_sht2x` for a hold-master sensor). A review flagged this roster
duplication and proposed making a Rust preset table the single source, generated
into an `I2C_PRESETS.generated.ts` through the existing `catalog:sync` path
(bless → `wire-interface.generated.json` → `codegen-node-registry.ts`) — the same
mechanism that already emits the `COMPONENT_PORTS` / `COMPONENT_EMITS` data tables.

Two facts reframed it:

- **The friction it targeted is already gone.** The shared-`I2cDeviceConfig` work
  (interpret and emit read one ungated struct) collapsed "add a device" from the
  old ~6-file cross-tier chore to **1 file** for a plain register-mapped device (an
  `I2C_PRESETS` row; Rust's `_ => &[]` / `other => other` defaults need no arm) and
  **2 files** when it needs init writes. The schema and node component are generic.
- **Presets are not Rust-authoritative.** `address` / `register` / `readLength` /
  `freq` / `label` are *user-overridable UI starting values*; the live runtime
  reads them from the node's own config, **never from a Rust roster**. Only
  `device_init_writes` / `effective_register` are runtime-consumed, and those
  already live in Rust.

## Decision

Keep the roster in TS. The deciding arguments:

1. **No correctness anchor to justify Rust ownership.** Ports/emits are generated
   from Rust because the runtime *enforces* them and the frontend MUST match
   (ADR-0007) — generation there prevents a real drift bug. Preset defaults have no
   such anchor: nothing in Rust validates a node's address/register against a
   roster, so there is no correctness reason for Rust to own them.
2. **It would invert ownership for a generation artifact.** A Rust preset table
   would hold `address` / `freq` / `label` that **Rust itself never reads** — data
   authored in Rust purely to be generated back into the frontend that does read
   it. That moves product copy (labels) and UI defaults out of the tier that owns
   them.
3. **Deletion test.** Imagine the generated Rust roster deleted: no runtime
   complexity reappears (the runtime never consumed it); only the frontend's
   default-population needs it — exactly where `I2C_PRESETS` already lives. The
   refactor concentrates nothing; it relocates.
4. **The current split is the sound equilibrium.** Rust owns the runtime-relevant
   datasheet ops (init/remap, keyed by id, shared by interpret + codegen); TS owns
   the UX defaults. Each tier holds what it consumes.
5. **Low residual benefit.** The win is saving one file per device and
   drift-proofing a roster whose drift ("a preset offered for a device whose init
   Rust lacks") is low-severity and caught the first time the device is tested —
   disproportionate to authoring a Rust table plus a generation hook.

The mechanism was not the blocker: the bless→sidecar→codegen path is proven and the
frontend blast radius is two files. The decision turns on ownership and value, not
feasibility.

## Consequences

- Adding a register-mapped device stays a 1-file TS edit (2 with init writes).
  Accepted as the natural cost, not debt.
- The roster lives where it is edited and rendered; the `device_init_writes`
  docstring intent ("adding a sensor is one edit, both sides pick it up") holds for
  the *runtime-relevant* half and is deliberately not extended to UI defaults.
- The unused `I2cPreset.description` field was removed in the same pass (it was
  never read by any consumer).

## Revisit if (the trigger)

- Preset defaults become **runtime-authoritative** — e.g. the runtime starts
  validating a node's address/register against a known-device roster, giving
  generation a correctness anchor — **or**
- a **second consumer** of the same defaults appears (e.g. the desktop host needs
  the roster), making a single source pay back across tiers — **or**
- roster drift ships a **real bug** (a preset offered for a device the runtime
  cannot bring up).

When the trigger fires, the sanctioned path is the existing wire-interface
generator (Rust const → `catalog:sync` sidecar → `codegen-node-registry.ts`),
**not** a `macro_rules!` or a cross-crate `include_str!` into core (both rejected
by ADR-0007).

## References

- [ADR-0007](0007-node-wire-interface-emit-contract.md) — generate-from-Rust for
  the wire interface, justified because Rust is authoritative there; the pattern
  this ADR declines to extend to non-authoritative preset data.
- [ADR-0012](0012-component-trait-plumbing-stays-explicit.md) — a prior
  "deliberate non-change" recording why not to generate uniform-but-shallow code.
- `crates/microflow-core/src/config/i2c_device.rs` — the ungated single source for
  the runtime-relevant datasheet ops (`device_init_writes`, `effective_register`).
- `apps/web/src/components/flow/nodes/i2c-device/i2c-device.constants.ts` — the
  hand-authored roster this ADR keeps in TS.
