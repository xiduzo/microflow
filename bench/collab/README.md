# Collab presence load test (k6)

Load-tests the one part of Microflow that is a network service: the Yjs
collaboration room that `apps/server` serves at `/yjs/:flowId`.

## Why this exists

`ReactFlowCanvas` broadcasts the local cursor through Yjs awareness. It used to
call `updateCursor` straight out of `onMouseMove`, which meant one awareness
encode and one socket write **per mouse event** — 100–125 Hz on a normal mouse.
It is now coalesced onto `requestAnimationFrame`, so it tops out at the display
refresh rate (~60 Hz).

That send rate is the highest-leverage number in the room, because the server's
work per awareness message is not constant — it decodes the update, runs a
`JSON.parse`/`JSON.stringify` round trip per client state in
`stampAwarenessIdentity`, applies it, and then writes to **every other socket in
the room**:

```
server work/sec  ∝  messages/sec/client × N × (N − 1)
```

So halving the client's rate halves a term that is already quadratic in room
size. This benchmark measures what that is worth.

## What it does and does not cover

**Covers:** the real `YjsServer` message path — awareness decode, identity
stamping, `applyAwarenessUpdate`, and room fan-out.

**Does not cover:** the Rust flow engine, the wasm boundary, or canvas
rendering. None of those cross a network, so k6 cannot see them; they want
`criterion` and browser profiling respectively.

Two things are stubbed in the harness, neither on the path under test:

- **Auth.** `apps/server` resolves a better-auth session and a per-flow role
  before `join`. That runs once per *connection*, not per message, so it is
  noise in a message-rate benchmark (and it would need Postgres).
- **Persistence.** `MemoryRoomStore` — the adapter the package already ships for
  tests — replaces `drizzleRoomStore`. Persistence is debounced and driven by
  *document* updates; this benchmark drives *awareness*, which never reaches the
  store.

## Running it

```sh
bun bench/collab/server.ts          # terminal 1 — harness on :7777

# terminal 2 — one run per rate
k6 run -e VUS=8 -e RATE_HZ=125 -e DURATION_S=20 bench/collab/awareness-load.js
k6 run -e VUS=8 -e RATE_HZ=60  -e DURATION_S=20 bench/collab/awareness-load.js
```

`VUS` is collaborators in one room, `RATE_HZ` the per-client cursor rate
(125 ≈ raw `mousemove`, 60 ≈ `requestAnimationFrame`). Use a distinct `FLOW_ID`
per run so rooms do not pool.

The headline metric is **`presence_propagation_ms`** — how long after a peer
moves their cursor this client sees it, i.e. the number a user actually feels.
`teardown` also prints the server-side counters from the harness's `/stats`.

## Results

k6 v1.4.1, Bun harness and load generator on the same 4-core container. One
room, 20 s, cursors staggered across the send window so the clients are not
phase-locked.

### 8 collaborators — clean comparison

Both runs delivered ~100% of their intended message rate, so this is
apples-to-apples.

| | 125 Hz (raw mousemove) | 60 Hz (rAF, this branch) | Δ |
|---|---|---|---|
| messages in | 999/s | 470/s | **−53%** |
| socket writes (fan-out) | 6,995/s | 3,289/s | **−53%** |
| bytes written | 18.67 MiB | 8.80 MiB | **−53%** |
| server CPU | 3,341 ms | 2,626 ms | −21% |
| propagation p95 | 5 ms | 3 ms | −40% |
| propagation max | 111 ms | 35 ms | −68% |

Traffic and fan-out halve exactly as the model predicts. CPU falls by less
because a slice of it is fixed event-loop cost that no message rate changes —
and because k6 shares the box, so the CPU column is indicative, not an isolate.
The message and byte counters are exact.

### 16 collaborators — where it stops being an optimisation

| | 125 Hz | 60 Hz | |
|---|---|---|---|
| messages in | 1,441/s | 939/s | |
| socket writes (fan-out) | 21,598/s | 14,085/s | |
| bytes written | 57.89 MiB | 37.73 MiB | |
| propagation avg | **4.58 s** | 8.4 ms | |
| propagation p95 | **8.5 s** | 28 ms | threshold `p(95)<100ms` |
| intended rate delivered | 72% | 98% | |

At 125 Hz the 16-person room falls off a cliff: cursors run **seconds** behind,
and the load generator cannot even push its intended rate — the whole pipe is
saturated on this hardware. At 60 Hz the same room on the same box sits at 28 ms
p95 and delivers 98% of its messages.

Read that as a regime change rather than a precise 300× latency number: with
generator and server sharing four cores, some of the 8.5 s backlog is the
client side queueing. What it does establish is that the throttle moves a
16-person room from *saturated* to *comfortable* on identical hardware — which
is the difference between collaboration feeling broken and feeling live.

CPU is flat between the two 16-VU runs (3,390 vs 3,212 ms) precisely because the
box is pinned in both; there, latency and bytes are the signal, not CPU.
