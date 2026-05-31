# Glossary — Ubiquitous Language

Shared domain vocabulary for microflow. Add terms here as bounded contexts and concepts are defined.

## Bounded Contexts

- **Live Flow Runtime** — Executes a Flow by _interpreting_ it live in the Rust `FlowRuntime`, driving the board over **Firmata** across a serial tether. The board only acts while a computer is connected. _(established context)_
- **Sketch Generation** — Translates a Flow _ahead-of-time_ into an Arduino **Sketch** (`.ino`/C++) the board runs standalone, no host or Firmata. Shares the Flow graph and Node catalog with Live Flow Runtime; the two are sibling execution targets for one Flow. Introduced in [#22](https://github.com/xiduzo/microflow/issues/22).
  - **Networked Device** (sub-capability) — Generation path for Cloud Nodes (Mqtt, Figma, Llm, Monitor), which require a WiFi-capable board target, on-device network clients, and credential handling. [#22](https://github.com/xiduzo/microflow/issues/22).

## Terms

- **Flow** — The user-authored graph of Nodes and edges describing device behavior.
- **Node** — A single building block in a Flow (e.g. Led, Button, Sensor, Calculate). Catalog: `apps/web/node-components.json`.
- **Sketch** — The Arduino program (`.ino`/C++) generated from a Flow.
- **Flow Author** — The maker who builds a Flow and wants it to run on their board.
- **Cloud Node** — A Node needing off-device networking: Mqtt, Figma, Llm, Monitor.
- **Untether** — Make a board run its Flow standalone, with no computer attached.
