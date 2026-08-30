# Benchmarks

Two benchmark suites, deliberately different tools, because they measure
different kinds of thing.

| Suite | Tool | What it measures | Where |
|---|---|---|---|
| Flow engine | criterion | In-process cost of one runtime turn | `crates/microflow-core/benches/runtime.rs` |
| Collab presence | k6 | Network service under N concurrent clients | `bench/collab/` |

Neither covers **canvas rendering** or the **wasm boundary**. Those live in the
browser; they want a profile from devtools or a Playwright trace, not a harness
in this repo.

## Flow engine (criterion)

```sh
cargo bench -p microflow-core --features runtime --bench runtime
cargo bench -p microflow-core --features runtime --bench runtime -- inbound   # one group
```

`runtime` is not a default feature, so `--features runtime` is required; the
`[[bench]]` stanza declares it via `required-features` so a plain `cargo bench`
skips the target rather than failing to compile.

Four groups, each driving the runtime through its **public entry points** with a
flow built by `update_flow` from the real component registry — no test doubles:

- **`inbound`** — `feed_bytes` with Firmata analog frames into 1/8/16 sensor
  nodes. The highest-frequency entry point in the system. Split into
  `feed_bytes_changing` (the value moved: full pin scan, drain, route, encode)
  and `feed_bytes_unchanged` (the value did not: the far more common case, which
  should collapse to nothing).
- **`timers`** — `wake` on 1/16/64 Interval nodes, round-robin so the outstanding
  timer lookup is not a single hot key.
- **`fanin`** — an event into a Calculate node, which aggregates and so rebuilds
  a snapshot of all its inputs on every delivery. Its fan-in is fixed at 4 while
  the flow around it grows by 0/64/256 **inert** edges. If the inert edges move
  the number, delivery cost is a function of total flow size rather than of the
  node's own fan-in.
- **`cascade`** — one injected value through a chain of 1/8/32 nodes, draining in
  a single turn. Isolates per-event drain overhead from per-turn overhead.

Every scenario asserts, outside the timed section, that it actually produces
events or bytes. A benchmark that silently times a mis-wired flow is worse than
no benchmark — it reports a number, the number is stable, and it is meaningless.
That guard caught exactly this while these benches were being written.

### A/B against another commit

Criterion's own `--save-baseline` only compares runs of the *same* checkout, so
comparing two commits means running the *same harness* against both:

```sh
git worktree add /tmp/base <commit>
mkdir -p /tmp/base/crates/microflow-core/benches
cp crates/microflow-core/benches/runtime.rs /tmp/base/crates/microflow-core/benches/
cp crates/microflow-core/Cargo.toml /tmp/base/crates/microflow-core/   # criterion dep + [[bench]]
cp Cargo.lock /tmp/base/

ARGS="--warm-up-time 2 --measurement-time 6 --sample-size 50 --noplot"
(cd /tmp/base && cargo bench -p microflow-core --features runtime --bench runtime -- $ARGS)
cargo bench -p microflow-core --features runtime --bench runtime -- $ARGS
```

Run them **sequentially, never in parallel** — two benchmark processes on the
same cores measure each other.

`benches/runtime.rs` deliberately avoids `Effects::is_empty()` (added on the
optimisation branch) and spells the check out field by field, so one harness
file compiles against commits on either side of it. An A/B is only fair if the
harness is byte-identical; `md5sum` both copies before believing a delta.

### Recorded A/B: the per-event optimisation branch

`1b0b77f` (before) vs the branch, one harness file, run sequentially on an idle
4-core Xeon @ 2.80 GHz, rustc 1.94.1, release profile. 50 samples, 1 s warm-up,
4 s measurement. Every row's criterion confidence intervals are disjoint.

| benchmark | before | after | Δ |
|---|---:|---:|---:|
| `inbound/feed_bytes_changing/1` | 886 ns | 771 ns | **−13.0%** |
| `inbound/feed_bytes_changing/8` | 992 ns | 899 ns | −9.3% |
| `inbound/feed_bytes_changing/16` | 1.15 µs | 1.05 µs | −8.1% |
| `inbound/feed_bytes_unchanged/1` | 139 ns | 122 ns | −12.2% |
| `inbound/feed_bytes_unchanged/8` | 255 ns | 238 ns | −6.7% |
| `inbound/feed_bytes_unchanged/16` | 393 ns | 407 ns | see note |
| `timers/wake_and_rearm/1` | 771 ns | 738 ns | −4.3% |
| `timers/wake_and_rearm/16` | 813 ns | 752 ns | −7.5% |
| `timers/wake_and_rearm/64` | 801 ns | 758 ns | −5.3% |
| `fanin/inject_into_aggregator/0` | 720 ns | 645 ns | −10.5% |
| `fanin/inject_into_aggregator/64` | 774 ns | 646 ns | −16.6% |
| `fanin/inject_into_aggregator/256` | 902 ns | 660 ns | **−26.9%** |
| `cascade/drain_chain/1` | 716 ns | 651 ns | −9.1% |
| `cascade/drain_chain/8` | 2.93 µs | 2.59 µs | −11.5% |
| `cascade/drain_chain/32` | 10.67 µs | 9.88 µs | −7.4% |

**The `fanin` row is the one that matters most**, and not because −26.9% is the
biggest number. Read the column, not the row:

```
filler edges:        0        64       256
before:            720 ns    774 ns    902 ns     ← grows with the whole flow
after:             645 ns    646 ns    660 ns     ← flat
```

The aggregating node's own fan-in is fixed at 4 in all three. Before, delivering
into it got more expensive as *unrelated* parts of the canvas grew, because
snapshot delivery walked the entire edge list; now it is a hash lookup and the
filler is invisible to it. The −26.9% at 256 edges is not the ceiling — it is
whatever the user's flow size makes it.

**Note on `feed_bytes_unchanged/16`.** This row read +3.6% (a regression) in the
first pass — the only row that did. It is the shortest-running benchmark in the
suite (~400 ns) and therefore the most sensitive to ordering and thermal drift.
Re-running the group with the *branch measured first*, to keep run-order drift
from masquerading as a result, put it at **−4.7%**, with every other row in the
group reproducing within ~1.5 points. The honest reading is that this row is
somewhere between flat and modestly faster, not that it regressed — and that a
single criterion pass on a shared container is not enough to call a sub-5%
change on a sub-microsecond benchmark.

## Collab presence (k6)

See [`bench/collab/README.md`](../bench/collab/README.md) — what it measures,
what is stubbed and why, and the recorded numbers.
