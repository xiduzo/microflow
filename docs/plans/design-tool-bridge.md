# Design-tool bridge — aligning the Figma and Penpot plugins

Status: Implemented (2026-09-26) as a five-layer stacked PR. The decision is recorded in [ADR-0028](../adr/0028-design-tool-bridge-protocol.md); what was built, what differs from this plan, and what the work turned up are in [§6](#6-outcome-and-findings). D4 (Penpot hosting) is still open.

Goal: one bridge for two tools. The Figma and Penpot plugins speak the same wire protocol and
share one implementation of it. Studio consumes either tool in the browser, on desktop, and in
Arduino sketches. Per-tool code shrinks to the parts that really differ: reading and writing the
tool's values, and the look of the panel.

---

## 1. What is there today

### 1.1 The two plugins side by side

| | Figma plugin (`apps/figma-plugin`) | Penpot plugin (`apps/penpot-plugin`) |
|---|---|---|
| Stack | Preact + create-figma-plugin UI | React 19 + Vite + Tailwind |
| Value source | Variables in the `MHB` collection | Tokens in the `MHB` token set (created and activated if missing) |
| ID on the wire | Stable: `VariableID:1:2` → `1-2` | Token **name**, `/`→`-`. Lossy on decode, and the binding breaks on rename |
| Types | BOOLEAN, FLOAT, STRING, COLOR | color; 11 numeric types → number; the rest → string. No boolean |
| Color on the wire | `{r,g,b,a}`, floats 0–1 | `{r,g,b,a}`, **0–255**. Write-back drops alpha and reads Studio's 0–1 input as 0–255 |
| Variables list | `{[id]: {id, name, resolvedType}}` | `{[path]: {path, name, type}}` |
| Topic segment | `figma` | `penpot` |
| Change detection | UI polls the sandbox every 250 ms | Same |
| Toast / open link | `figma.notify` / `figma.openExternal` | `console.info` / `window.open` via a sandbox relay |
| Settings storage | `figma.clientStorage` | `localStorage`, through a sandbox round-trip that does nothing |
| Types package | `@figma/plugin-typings` 1.109.0 (latest 1.139.0) | `@penpot/plugin-types` 1.4.2 + hand-written token types |
| Distribution | Figma Community, id `1373258770799080545`, v0.9.1 | None. Manifest host is `http://localhost:5173`, and a production build bakes that host into `plugin.js`. `icon.png` is missing |
| CI | oxlint at warning level only | Same |
| Tests | None | None (the `.kiro` checkpoints "all tests pass" are ticked anyway) |

The Penpot plugin started as a copy of the Figma plugin (`9405ca1e`, 2026-04-01). Both plugins
have been untouched since May. Both have their own copy of `messages.ts`,
`MqttVariableMessenger`, the hooks, both stores and all three pages. `vertical-structure.md` F9
already noted the drift.

### 1.2 Studio only knows Figma

- The `figma` segment is hard-coded: `crates/microflow-core/src/nodes/figma/runtime.rs:47,218,222`,
  `apps/web/src/cloud/figma.ts:38,46` and `nodes/figma/codegen.rs:70`. Nothing in `apps/web`
  or `crates` mentions Penpot. The only mention is `packages/mqtt/src/types.ts:3`, where Penpot
  is listed as a client name.
- So Penpot values never reach Studio. Fixing the segment alone would not help, because the list
  shape (`path`/`type` instead of `id`/`resolvedType`) and the color scale are also wrong for
  Studio. The dropdown would stay empty and colors would be wrong in both directions.

### 1.3 Studio-side bugs (they affect both tools)

1. **A new node cannot list variables.** The list and status topics are subscribed only after a
   variable is chosen (`runtime.rs:197-202`), and you choose a variable from that list.
   This regressed in `66e36229` (#16), which removed the frontend subscription.
2. **Pairing uses the account display name.** The uid is `session.user.name ?? "anonymous"`
   (`cloud/figma.ts:79-80`).
   - The plugins accept only `[a-zA-Z_]{5,}`, so a display name with a space or a digit cannot
     be typed into them.
   - Every logged-out user shares `anonymous` on the public broker.
   - No Studio UI shows the uid.
   - Changing the uid does not re-dispatch the flow.
3. **Two plugins on one uid collide.** Both answer on `app/variables/response`, and the store
   keeps whichever answer arrives last. `pluginConnected` is a single flag that watches only
   `figma/status`.
4. COLOR is scaled twice in the node UI (`nodes/figma/figma.tsx:229-231`).
5. Selecting a FLOAT variable deletes `reset` edges (`figma.tsx:148-151`).
6. `debounceTime` is shown and stored, but the runtime never uses it.
7. The browser publishes the handshake before it subscribes (`cloud-performer.ts:146` vs.
   `148-149`), but ADR-0011 says after.
8. `app/status=connected` is retained, and neither host sets a last-will message, so a crashed
   Studio shows as "connected" forever. After a reconnect, `variables/request` is not sent again.
9. The handshake fires for any `microflow/{x}/…` topic, including topics of generic MQTT nodes.
10. **Codegen:** the sketch gets an empty uid (`microflow//figma/...` in
    `tests/golden/esp32_cloud.ino`) and a `REPLACE_ME` broker, because the Figma node does not
    get the credentials surface. Values are always published with `toFloat()`.
11. The `@microflow/mqtt` topic matcher has no anchors, and it maps `+` to `\S+`, which also
    matches across `/` (`packages/mqtt/src/client.ts:175-192`).

### 1.4 Plugin-side bugs

**Figma**
- The plugin publishes `Object.values(valuesByMode)[0]`, which is not guaranteed to be the
  default mode. An aliased variable publishes the alias object, not its value.
- EASING and TIMING variables (typings 1.133) and `VariableComposedColor` (1.139) can already
  exist in `MHB`, but the code handles only 4 types.
- The `DELETE_VARIABLE` handler is dead code: no UI calls it.

**Penpot**
- The name-based IDs, the color scale and the alpha loss described in §1.1.
- `fontWeights` goes through `parseFloat`, so `"bold"` is dropped.
- The toast only goes to the console, and `console.log(tokens[0])` is left in.
- The hand-written `PenpotTokenTheme` type is wrong: it declares `sets`, but the real member is
  `activeSets`.
- `messages.ts` says the panel cannot resize, but `penpot.ui.resize` exists.

### 1.5 Docs and templates describe a contract that no code implements

- The docs describe `figma/<name>` topics on the generic MQTT node. These appear in both
  Penpot pages and in the `sensorToFigma` / `figmaToLed` templates
  (`apps/web/src/flows/templates/index.ts:417-443`). Neither plugin publishes or listens on
  those topics.
- `manipulating.mdx:31,62` documents `microflow/v1/<id>/…/VariableID:1:25`.
- The prototype workflow uses a `/set` web route and a `microflow-studio://` scheme. Neither
  exists.
- Both plugins' help buttons link to a broken anchor.
- `express/figma.mdx` says the node was renamed "MQTT (Express)" and has a Topic field. In the
  code it is still "Figma", with a variable picker.
- Penpot `mqtt.mdx` describes Host and Port fields that do not exist, and says the identifier
  defaults to a random value.
- The README says a tap in a Penpot prototype can turn on an LED. It cannot.
- `QA.md` says the plugins are type-checked. They are not.
- CONTEXT.md has no terms for the Design-Tool Bridge, although `VISION.md:44` names it as a
  bounded context.

### 1.6 What the tools support (researched 2026-09-25)

- **Penpot still has no variables.** Issue #1994 is still open. Tokens are the only mechanism:
  17 types, none of them boolean. Official token types for plugins ship in
  `@penpot/plugin-types` 1.5.0, but only on the `next` dist-tag (`latest` is still 1.4.2).
- **Neither tool has a change event.** Figma has no event for variables. Penpot's
  `contentsave` can trigger a re-read after the user's own edits; edits by collaborators
  probably do not fire it (not verified). Polling stays.
- **Plugins run only in the editor.** Figma plugins do not run in Presentation mode. Penpot
  plugins do not load in view mode, and Penpot prototype actions cannot touch tokens.
- **Penpot distribution:** you host the manifest yourself, with CORS enabled. A manifest with
  `"version": 2` uses its own directory as the base URL, and the `host` field is ignored. Plugins
  are listed on Penpot Hub. There is no toast API; `window.open` works from the UI.

**Consequence:** in both tools the bridge works only while the design file is open in the
editor. It links hardware to the values in that open file. Both tools can support this equally;
the prototype use case needs separate work (§5).

---

## 2. Target

### 2.1 Principles

1. **Write the protocol down once.** Record it in an ADR and in CONTEXT.md terms. Add a shared
   fixture that both the TS package tests and the Rust tests check, like the catalog parity
   guard from ADR-0007.
2. **The Figma plugin's current wire format is the reference.** The Figma plugin already
   published on Community keeps working with the new Studio, so no forced plugin update.
3. **The tool is a parameter, not a copy.** `{tool}` ∈ `figma | penpot`.
4. **Per-tool code is limited to:**
   - a sandbox adapter: list, write, and a change trigger;
   - host glue: transport, toast, open link, storage, theme, resize;
   - views.

### 2.2 Protocol: today's v1, with the tool as a parameter

| Topic (`microflow/{uid}/…`) | Direction | Payload | Retained |
|---|---|---|---|
| `{tool}/status` | plugin → | `connected` / `disconnected` (last will) | yes |
| `{tool}/variables` | plugin → | `{[id]: {id, name, resolvedType}}` | yes |
| `{tool}/variable/{id}` | plugin → | JSON value | no |
| `app/status` | Studio → | `connected` / `disconnected` | yes, **plus a new last will** |
| `app/variables/request` | Studio → | empty | no |
| `app/variable/{id}` | plugin → (reply to request) | JSON value | no |
| `app/variable/{id}/set` | Studio → | JSON value | no |

Rules:
- `{id}` is a stable, topic-safe ID. For Figma it stays `VariableID:1:2` → `1-2`. For Penpot it
  becomes the token's `id` (a uuid) instead of its name.
- `resolvedType` ∈ `BOOLEAN | FLOAT | STRING | COLOR`. Each tool maps its own types to one of
  these, or skips them.
- COLOR is `{r, g, b, a}` with floats from 0 to 1.
- Studio reads each tool's list only from the retained `{tool}/variables`.
  `app/variables/response` becomes legacy: current plugins still send it, and Studio ignores it.
  This removes the two-plugin collision without a plugin update.
- IDs belong to one tool. A `/set` for a Penpot ID that reaches the Figma plugin does nothing,
  and the other way round. The spec states this explicitly.

**Type mapping**

| Figma | → |
|---|---|
| BOOLEAN, FLOAT, STRING, COLOR | as is. The value is read from the collection's default mode, with aliases resolved. Composed colors are resolved or skipped |
| EASING, TIMING | skipped |

| Penpot token type | → |
|---|---|
| `color` | COLOR (hex ↔ floats 0–1, alpha kept, written back as `#rrggbbaa`) |
| `number`, `dimension`, `opacity`, `rotation`, `sizing`, `spacing`, `borderWidth`, `borderRadius`, `fontSizes`, `letterSpacing` | FLOAT |
| `fontWeights`, `fontFamilies`, `textCase`, `textDecoration` | STRING |
| `shadow`, `typography` | skipped (composite) |
| — | No BOOLEAN. The docs say to use a `number` token with 0/1 |

### 2.3 Code layout

**New package `packages/design-bridge`, with no framework dependencies:**
- `protocol.ts`: topic builders and parsers, ID codecs, `BridgeVariable`, `ResolvedType`, and
  value codecs (bool, float, string, color). It replaces the copied `toBooleanOrNull`,
  `toFloatOrNull`, `shortVarId`/`fullVarId` and `shortTokenId`/`fullTokenId`.
- `bridge.ts`: the engine that is copied today as `MqttVariableMessenger`. It handles dedupe,
  the retained list, the reset on reconnect, replies to requests and routing of `/set`. It takes
  a `DesignToolAdapter { tool, list(), set(id, value) }`. It is a plain class; each plugin wraps
  it in a hook of about 10 lines.
- `rpc.ts`: the typed sandbox↔UI router that is copied today as the two `messages.ts` files.
  Each host supplies a transport: Figma wraps messages in `pluginMessage`, Penpot does not.
- `pairing.ts`: Bridge ID validation. Studio and both plugins use the same rule.
- `ui/` (headless): the app store, the navigation store, the MQTT settings form model, and
  copy-to-clipboard.
- `fixtures/protocol.json`: cases of topic, payload and decoded value. The bun tests check it
  here, and Rust tests in `microflow-core` check the same file.

**What each plugin keeps:**
- A sandbox adapter: Figma variables, or Penpot tokens plus the `contentsave` trigger.
- Host glue: notify/toast, open link, storage, theme, resize.
- The Home, MqttSettings and Variables views, in each tool's own look (create-figma-plugin UI;
  Penpot plugin styles or Tailwind).

**Studio:**
- The Rust `nodes/figma/` gets a `source` config field (serde default `figma`). The topic
  builders take the tool.
- Studio subscribes to the list and status topics of each tool as soon as the broker and uid are
  set, not only after a variable is chosen.
- The store is keyed by tool: `variables[tool]`, `connected[tool]`.
- The node picker lists variables from every connected tool, grouped by tool. Picking a
  variable sets `source`, `variableId` and `resolvedType`.

---

## 3. Plan: a stack of PRs, each one shippable

Order: 1 → 2 → 3 → 4 → (5 and 6 in either order) → 7 → 8 → 9.

- PR 3 tests the new package without touching Studio.
- PR 4 tests the new Studio against the unchanged Figma plugin.
- Only then does Penpot move over.

1. **Decide and write it down** (docs only).
   - An ADR "Design-tool bridge protocol" that formalizes §2.2 and amends ADR-0011:
     - the handshake runs only for bridge uids;
     - subscribe before publish;
     - a last will for `app/status`.
   - CONTEXT.md terms: Design tool, Bridge variable, Bridge ID, MHB, tool segment.
   - This plan moves to Accepted.
2. **`packages/design-bridge` plus the fixture.** Extract it from the Figma plugin (the
   reference), with bun tests. Fix the `@microflow/mqtt` topic matcher (anchored, `+` matches
   one level), with tests.
3. **Move the Figma plugin onto the package, with no wire change.**
   - Fixes: default mode, alias resolution, skip EASING/TIMING, composed color.
   - Typings 1.109 → 1.139; remove `DELETE_VARIABLE`; add a `check-types` script.
4. **Studio: consumer that knows about both tools, plus fixes.**
   - `source` in the Rust runtime and in the TS schema and UI.
   - Fixes for §1.3 bugs 1 (list subscribed before a variable is chosen), 3 (store keyed by
     tool; stop reading `app/variables/response`), 4, 5, 6 (implement or drop), 7, 8 (last
     will; request again on reconnect) and 9.
   - Rust tests for `parse_payload` and `subscriber_wiring`, against the fixture.
5. **Pairing.** Replace the display name with an explicit Bridge ID (D2). Changing the ID
   re-dispatches the flow.
6. **Move the Penpot plugin onto the package.**
   - `@penpot/plugin-types` 1.5.0; delete `globals.d.ts`.
   - An adapter with uuid IDs, the type map and the color codec.
   - `contentsave` plus polling as the change trigger.
   - A toast component; `localStorage` used directly from the UI; `penpot.ui.resize` per page;
     a `check-types` script.
   - Check end to end, in browser and desktop Studio: a Penpot token drives a node, and a node
     drives a Penpot token.
7. **Codegen parity** (§1.3 bug 10): uid and broker come from the credentials surface, publishes
   are typed JSON per `resolvedType`, topics include the `source` segment, and the golden files
   are updated.
8. **Delivery.**
   - CI builds and type-checks both plugins.
   - Penpot hosting (D4): a `version: 2` manifest with relative paths, an icon, CORS; submit to
     Penpot Hub.
   - Plugin versioning (D5 note); publish the PR 3 build on Figma Community.
9. **Docs and templates.**
   - One "Design-tool bridge" section:
     - overview: an editor-time bridge, and what each tool supports;
     - pairing;
     - a protocol reference generated from the fixture;
     - install pages for Figma and Penpot;
     - troubleshooting.
   - Remove everything listed in §1.5. Rebuild the `sensorToFigma` and `figmaToLed` templates
     on the node, and fix the plugin help links.
   - Update QA.md, the README's Penpot claim, and SECURITY.md:
     - broker credentials are stored in plain text in plugin storage;
     - `allowedDomains: ["*"]`;
     - `rejectUnauthorized: false`.

---

## 4. Decisions needed

D1, D2, D3 and D5 are decided as recommended; D4 is still open.

| # | Question | Recommendation | Alternative | Status |
|---|---|---|---|---|
| D1 | Node shape | **One node with a `source` field.** Keep the persisted type `Figma` (no Yjs migration) and relabel it "Design variable" | A separate `Penpot` node type that shares the Rust implementation | Decided: as recommended |
| D2 | Pairing | **A generated Bridge ID, shown in Studio with a copy button** and editable. One validation rule everywhere | Keep the display name, and loosen the plugin validation to match it | Decided: as recommended |
| D3 | UI sharing | **Share the headless parts (stores, form model, protocol); each tool keeps its own views** | One shared React UI, with the Figma plugin on `preact/compat` | Decided: as recommended |
| D4 | Penpot hosting | **A static path on the web app** (e.g. `/plugins/penpot/manifest.json`). It ships with each Studio release, so the protocol stays in step | Its own Dokploy static app or subdomain | Open |
| D5 | Protocol | **Keep v1 wire-compatible**, so the published Figma plugin keeps working | A clean v2 (retained values, `/set` addressed to the tool, no request/response), with a migration window | Decided: as recommended |

## 5. Out of scope for now

- **Prototype → hardware.** Neither tool runs plugins in prototype view. The old Figma
  workaround (a link to a `/set` route) no longer exists. This needs its own spike if we want it.
- **Penpot booleans.** Blocked on Penpot, which has no boolean token type.
- **Penpot edits made by collaborators.** They probably do not fire `contentsave`; polling
  covers them.
- **Renaming the persisted node type `Figma`.**

---

## 6. Outcome and findings

### 6.1 What was built

The nine planned PRs landed as five stacked layers:

| Layer | Contents |
|---|---|
| 1. Protocol | `packages/design-bridge` (protocol, codec, `DesignBridge` engine, sandbox↔UI messages, Bridge ID rule, shared React hooks) and its fixture; the `@microflow/mqtt` topic matcher fix; ADR-0028; CONTEXT.md terms |
| 2. Figma plugin | Plugin on the package, typings 1.109 → 1.139, value bugs fixed. Wire format unchanged |
| 3. Penpot plugin | Plugin on the package, official `@penpot/plugin-types` 1.5.0, token uuids, 0–1 colors, manifest v2, icon, toasts |
| 4. Studio | Rust `design_bridge.rs` mirror; the node reads both tools; Bridge ID; handshake fixes; sketch parity; templates; CI builds the plugins |
| 5. Docs | Fumadocs, README, ARCHITECTURE, SECURITY, steering docs, this section |

### 6.2 Where the build differs from the plan

- **Pairing (plan PR 5) went into the Studio layer.** The Bridge ID changes the same store, dispatcher and node UI, so splitting it out would have meant editing those files twice.
- **The Rust protocol is a top-level core module, `design_bridge.rs`,** not a file in `nodes/figma/`. The node-boundary guard (ADR-0026) allows only `config`, `runtime` and `codegen` in a node directory, and core's announce policy needs the protocol too.
- **The node's `debounceTime` setting is gone.** The runtime never read it; it was a control that did nothing.
- **Sketches do not publish typed JSON.** Both plugins coerce plain text to the variable's type, so the ESP32's raw `String` payloads already arrive correctly. The broker now comes from the flash-time credentials, and a BOOLEAN variable reads as a boolean.
- **Colors are snapped to 8 bits on the wire.** Without that, a color Studio set came back from Penpot's hex slightly rounded and was published once more.
- **Penpot permissions are `content:read`, `content:write`, `library:read`,** not the planned `library:*` + `allow:localstorage`: see §6.3.

### 6.3 Findings

**Penpot (plugin API 1.5.0, checked against a live instance and Penpot's source)**
- Penpot still has no variables. Tokens are the only mechanism, and there is no boolean token type (issue #1994 is open).
- The runtime differs from the types:
  - a token in an inactive set has `resolvedValue: null`;
  - a color's `resolvedValue` drops its alpha, so the plugin reads the alpha from `token.value`;
  - a multi-word font family such as "IBM Plex Mono" resolves to nested word arrays;
  - `fontWeights` resolves to a number.
- Token writes are checked against `content:write`, not `library:write`. `allow:localstorage` only gates the sandbox's `penpot.localStorage`; the UI iframe can always use its own `localStorage`.
- Penpot ignores the manifest `host`. With `"version": 2` the host is the manifest's directory, and `ui.open` resolves a relative URL against it, so the build can be hosted under any path.
- `addSet` reaches the catalog asynchronously. Polling right after creating the MHB set would create a second one, so the plugin creates it once per session.
- `contentsave` is the only usable change signal; the 250 ms poll stays for edits it does not report.

**Figma (plugin typings 1.139.0)**
- There is no variable change event; polling is the only option.
- EASING and TIMING variables (1.133) and composed colors (1.139) can already exist in an MHB collection. The editor returns a composed color as a `COMPOSE_COLOR` expression, not the `{ color, opacity }` shape the typings declare (figma/plugin-typings#375); the plugin handles both.
- Plugins do not run in Presentation mode, so a prototype's "Set variable" actions never reach the plugin.

**Shared**
- The plugins' old default broker, `test.mosquitto.org`, resolved to `wss://…:8883`, which is plain MQTT over TLS and never accepted a WebSocket connection. `wss://test.mosquitto.org:8081/mqtt` works (tested live); saved settings with the old default are migrated when loaded.
- create-figma-plugin's esbuild build aliases every `react` import to `preact/compat`, which is why one set of React hooks serves both plugins.
- CI runs `bun test` from the repo root without the web app's environment. A module that imports `@/account/auth-client` fails there with "Invalid environment variables", so the design-bridge store keeps the auth hook in a separate file.

### 6.4 Verification

- `bun run check-types` (all six workspaces) and the builds of both plugins pass.
- `bun test`: 758 pass, including 83 in `packages/design-bridge` (fixture and engine) and the Studio store, performer and template guards.
- `cargo clippy --workspace --all-targets -- -D warnings -W clippy::pedantic` is clean; `cargo test --workspace --lib --tests` passes (675 core tests with `cloud`, 533 without), including the fixture tests and the golden sketches.
- `bun run build:wasm` passes, so the browser runtime compiles with the new node.
- The Penpot token reads and writes were exercised read-only against a live Penpot file.
- **Not tested:** a live round trip between Studio and either plugin inside Figma or Penpot.

### 6.5 Still open

- **D4, Penpot hosting.** The plugin works from its dev server and from any static host of `dist/`, but it is not deployed or listed on Penpot Hub.
- **Publishing the Figma plugin.** The Community version still has the old bugs (first mode instead of default, aliases, EASING/TIMING, broken default broker) until the new build is published.
- **Studio presence.** A crashed Studio leaves `app/status = connected` retained, because neither host sets a last will, and the browser does not send `variables/request` again after a reconnect.

