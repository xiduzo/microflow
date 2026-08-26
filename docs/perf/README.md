# Performance contracts

This directory records the performance-critical seams of Microflow: what each one
guarantees, where the guarantee is enforced, and the invariants a change must not
break. Each document describes the system as it stands.

| Document | Seam |
| --- | --- |
| [01-emission-ingest.md](01-emission-ingest.md) | The single funnel every runtime **Emission** passes through on its way to the canvas, and the signal clock that animates wires. |
| [02-pointer-rate.md](02-pointer-rate.md) | What is ephemeral vs durable at pointer rate: hover proximity, cursor awareness, node placement, local persistence. |
| [03-structural-projection.md](03-structural-projection.md) | The visual-field-stripped view of the flow shared by the runtime, Arduino codegen and the schematic, plus the no-op write guard on the **Flow Document**. |
| [04-board-store.md](04-board-store.md) | How board pin state is subscribed to, and the equality contract that decides which nodes wake on a board event. |
| [05-rust-hot-path.md](05-rust-hot-path.md) | Per-emit allocation, the router's edge index, and how the Firmata receive buffer is consumed. |
| [06-desktop-ipc-batch.md](06-desktop-ipc-batch.md) | How one runtime turn reaches the webview on desktop, and what ordering is guaranteed. |
| [07-generated-wire-types.md](07-generated-wire-types.md) | Where the cross-language wire types come from and what guards them against drift. |
| [08-wasm-error-seam.md](08-wasm-error-seam.md) | The fault taxonomy for calls into the wasm runtime, and where each class is routed. |

## Reference points

Two invariants underpin most of the above and are recorded as decisions rather
than here:

- [ADR-0004](../adr/0004-react-flow-bridge.md) — drag positions are ephemeral and
  coalesced to an animation frame; they do not reach the document.
- [ADR-0008](../adr/0008-effects-apply-policy.md) — the canonical order in which a
  **Runtime Host** applies one turn's `Effects`.
- [ADR-0017](../adr/0017-wasm-fault-seam.md) — one seam owns the wasm crossing; a
  runtime fault reaches a runtime surface, never the transport.

## Verifying

```sh
bun test                                   # browser host + collab + db suites
cd apps/web && bunx tsc --noEmit           # type surface
cargo test --workspace --lib --tests       # core runtime + desktop host
cargo clippy --workspace --all-targets -- -D warnings -W clippy::pedantic
```

Committed CI covers Rust only — `.github/workflows/rust.yml` runs the clippy and
test jobs. The TypeScript suites are not yet gated on a push.

Two gaps worth closing:

- `.github/workflows/typescript.yml` runs `bun test` and `bun run check-types`
  but is untracked, so it never executes on GitHub.
- `rust.yml`'s test job *executes* the ts-rs export tests, rewriting
  `apps/web/src/lib/bindings/` in the runner, but nothing asserts the tree is
  clean afterwards — so a Rust field rename without a regen passes both jobs. A
  `git diff --exit-code apps/web/src/lib/bindings/` step after the Rust tests
  closes it.
