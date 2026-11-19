# ADR-0028 — One design-tool bridge protocol for Figma, Penpot and Studio

- **Status:** accepted (2026-09-25); amended (2026-11-19)
- **Date:** 2026-09-25
- **Deciders:** sander
- **Amends:** [ADR-0011](0011-figma-announce-protocol-in-core.md)

> **Decision:** the Figma plugin, the Penpot plugin and Studio speak one MQTT
> protocol, defined once per language: `packages/design-bridge` (TypeScript,
> used by both plugins and by Studio's web code) and
> `crates/microflow-core/src/design_bridge.rs` (Rust, used by the runtime and
> codegen). Both are checked against one fixture,
> `packages/design-bridge/fixtures/protocol.json`. The design tool is a topic
> segment, not a copy of the code.

## Context

The Penpot plugin started as a copy of the Figma plugin and drifted: other topic
segment, other list shape, token names as IDs (lossy `/`↔`-` encoding), colors
on a 0–255 scale. Studio only knew the `figma` segment, so Penpot values never
reached a flow. The topic contract lived in four places (two plugins, the Rust
node, the web store) and in docs that described a fifth, and nothing checked any
of them against each other.

Studio also paired with a plugin through the account display name, which the
plugins' identifier rule (`[a-zA-Z_]{5,}`) often rejected, and every logged-out
user shared `anonymous` on the public broker.

## Decision

1. **Topics.** Every topic is `microflow/{uid}/{client}/…`, where `{client}` is the
   sender: a design tool (`figma`, `penpot`) or Studio (`app`).

   | Topic | Sender | Payload | Retained |
   |---|---|---|---|
   | `{tool}/status` | plugin (last will) | `connected` / `disconnected` | yes |
   | `{tool}/variables` | plugin | `{[id]: {id, name, resolvedType}}` | yes |
   | `{tool}/variable/{wireId}` | plugin | JSON value | no |
   | `app/status` | Studio | `connected` / `disconnected` | yes |
   | `app/variables/request` | Studio | empty | no |
   | `app/variable/{wireId}` | plugin, answering a request | JSON value | no |
   | `app/variable/{wireId}/set` | Studio | JSON value | no |

   This is the wire format the published Figma plugin already used, so it keeps
   working with the new Studio.

2. **Stable, topic-safe IDs.** `{wireId}` is the tool's own stable ID made
   topic-safe: Figma `VariableID:1:2` → `1-2`; Penpot token IDs (uuids) pass
   through. Penpot binds by token ID, not name, so renaming a token keeps the
   binding. IDs belong to one tool: a `/set` for an ID a plugin does not own is
   ignored.

3. **Values.** `resolvedType` ∈ `BOOLEAN | FLOAT | STRING | COLOR`; each tool maps
   its own types onto these or skips them (Figma `EASING`/`TIMING`; Penpot
   `shadow`/`typography`). A color is `{r, g, b, a}` with every channel 0–1.
   Receivers decode a payload as JSON when it parses and as text otherwise, then
   coerce it to the variable's type; a value that does not fit is dropped, not
   turned into a default.

4. **Studio reads each tool's list from its retained `{tool}/variables`** and
   subscribes to every tool's list and status as soon as a node has a broker and
   a Bridge ID — not only after a variable is chosen. `app/variables/response` is
   still answered by the plugins for older Studio versions, and ignored.

5. **The Bridge ID pairs Studio with the plugins** (the `{uid}` segment). Studio
   shows it on the design variable node, derives it from the account name, falls
   back to a random per-device ID, and lets the user override it. Studio and the
   plugins validate it with one rule: 5–64 of `A–Z a–z 0–9 _ -`. Changing it
   re-dispatches the flow.

6. **Amends ADR-0011.** The announce policy stays in core
   (`figma_announce_actions`), with two changes: the uid set is taken only from
   design-bridge topics (`bridge_uid` in Rust, `bridgeUid` in TypeScript), so a
   generic Mqtt node's `microflow/…` topic does not trigger a handshake; and
   the browser subscribes before it announces, so the plugins' answers arrive.
   The browser also announces `disconnected` when its cloud host is disposed.

## Consequences

- **One node for both tools.** The `Figma` node gains a `source` field (default
  `figma`, so existing flows are unchanged) and is labelled "Design variable".
  Its persisted type stays `Figma`: renaming it would need a document migration
  and buys nothing on the wire.
- **The plugins share their bridge engine, bridge session and sandbox routing**
  from `@microflow/design-bridge`; each keeps only a sandbox adapter, host glue
  and its own views (amendment below).
- **A protocol change is a fixture change first.** Adding a topic, a type or a
  coercion rule means editing `protocol.json`; the bun tests and the Rust tests
  then fail until both implementations agree.
- **Penpot has no boolean tokens.** The BOOLEAN type exists only for Figma; a
  Penpot number token takes 0/1.
- **Plugins run only in the editor.** Neither tool runs plugins in prototype view,
  so the bridge links hardware to the values in an open design file, not to a
  running prototype.
- **A crashed Studio.** Both hosts leave a will on every link to a broker: the
  `disconnected` of the first Bridge ID announced there, in uid order
  ([ADR-0049](0049-a-broker-session-leaves-its-goodbye-with-the-pool.md)). A
  crash therefore takes back that Bridge ID, once the broker notices the link
  is gone, and leaves any other Bridge ID on the same broker at `connected`.
- **After a reconnect.** Both hosts say `connected` and send
  `variables/request` again on every new link to a broker.

---

## Amendment (2026-11-19): the plugin side is one session, and presence has two payloads by name

The plugin half of the package has three parts. They sit above the protocol in
the Decision, which stands as written.

**The engine runs inside a plugin bridge session.** `DesignBridge` publishes a
tool's variables and applies the values Studio sets. One
`createPluginBridgeSession` per plugin window (`packages/design-bridge/src/session.ts`)
owns what surrounds it: the settings, the broker connection, the plugin's
`{tool}/status` announcement and last will, and the snapshot polling. The
session reaches the broker through mqtt.js inside this package; the root
export, which Studio's web code imports, is the protocol, the codec, the
engine, the messages, the sandbox routing and the pairing rule. Decided in
[ADR-0040](0040-plugin-bridge-session.md).

**A sandbox adapter is two functions.** Each tool implements `SandboxAdapter`
(`readSnapshot`, `writeValue`; `packages/design-bridge/src/sandbox.ts`), and
`createSandboxBridge` routes the UI's messages to it.

**The two status payloads are named once.** `PRESENCE` (`protocol.ts`) holds
`connected` and `disconnected`. A plugin's `{tool}/status` is `connected`
(retained, QoS 2) while its connection is up and `disconnected` by last will.
A plugin that reads `disconnected` on its own status topic after the broker has
sent its `connected` back announces `connected` again, so a late last will of a
connection it replaced does not leave it marked as gone.
