# ADR-0046 — Connection settings settle in their store, before anything connects

- **Status:** accepted (2026-11-19)
- **Date:** 2026-11-19
- **Deciders:** sander
- **Amends:** [ADR-0036](0036-browser-host-owns-subscription-state.md)

> **Decision:** what is typed into a broker's or an LLM provider's settings is
> held apart from the settings everything connects with, and joins them once
> the typing has stopped: 500 ms after the last edit, or at once when something
> must not act on older settings than the form shows. The settle point is the
> settings store (`apps/web/src/cloud/mqtt-broker.ts`,
> `apps/web/src/ai/llm-provider.ts`), so every reader of the settings, in both
> hosts, sees an edit once. Storage keeps the settings as typed.

## Context

The settings forms write a field at every keystroke, and most prefixes of a
URL being typed are URLs a connection can be opened to. A connection that
follows the settings therefore opens one connection per keystroke, each to a
possibly real server, with the stored credentials; for an LLM provider, a
probe sends a key or an endpoint to the provider a keystroke at a time.

The browser [CloudPerformer](../../CONTEXT.md#browser-cloudperformer) had its
own wait for this (one second per broker, ADR-0036 as first written). Every
other reader followed the keystrokes: the desktop host's broker sync, the
broker list a flow update carries, the browser's status probe, the Connection
Console's link, and every LLM provider probe and model list. A late answer to
a probe could also land on settings newer than the ones it was asked with, or
on a broker that had been removed.

## Decision

**D1 — Two halves in the store.** The broker store keeps `brokers`, the
**settled** settings every connection is made from, and `unsettled`, the
fields typed per broker since its settings last settled. Only the settings form
reads the typed half (`useBrokerSettingsForm`). The LLM provider store keeps
`providers` (as typed, what the form shows) and `settled` (what a provider is
checked with).

**D2 — Settling.** An edit settles `BROKER_SETTINGS_SETTLE_MS` /
`PROVIDER_SETTINGS_SETTLE_MS` (both 500 ms) after the last keystroke. A
broker's wait is its own: editing one broker leaves another broker's settings
as they are. The provider store has one wait for all providers. Adding,
removing and choosing another default are not typing and settle at once; a
store that loads its settings starts with them settled.

**D3 — Who reads what.** Every reader of the broker settings reads `brokers`:
the desktop host's broker sync, the broker list of a flow update, the browser
CloudPerformer (`resolveBroker`, `watchBrokers`), the browser status probe and
the console's link. The LLM status probe and the console's model list read
`settled`.

**D4 — Flushes.** Whatever must not act on older settings than the form shows
settles them first, without waiting (`settleBrokerSettings`,
`settleLlmProviders`): building a flow update, running a console command, the
broker form closing, and the page being hidden or left while the broker form
is open.

**D5 — Storage is as typed.** The stores persist what the form shows, so a
reload brings back what was on screen, settled. What was typed for a removed
broker, and its wait, go with it.

**D6 — Busy while typing.** A broker whose URL, username or password is typed
and not settled shows `connecting` in the form: the status the store holds is
that of the connection made from the settled settings.

## Considered options

- **Keep the wait in each consumer.** Each reader would need its own, they
  would settle at different moments, and the desktop sync and the console would
  have to be taught it one by one.
- **Apply settings at once.** One connection per keystroke of a URL.
- **An explicit "Connect" button.** It moves the settle decision to the user
  and changes the configuration pages, which write through as they are edited
  on both hosts.
- **One wait for the whole broker store.** A broker that is not being edited
  would wait for one that is.

## Consequences

- A URL typed in one go is connected to once, by every host and the console.
- A pause longer than 500 ms settles what was typed so far, and a connection is
  opened to it with the stored credentials.
- A flow update and a console command always use the settings the form shows.
- The browser CloudPerformer keeps no settle wait of its own; a connection
  follows the settled settings at once.
- The console's browser link is keyed on the broker's id, URL and credentials,
  so a corrected password reaches a new link.
- A late probe answer is dropped when its settings changed or its broker or
  provider was removed.
- The `Llm` node's performer and Ask AI resolve a provider from the typed
  `providers` at request time, not from `settled`.

## What this does NOT decide

- What a connection does once its settings settle: the hosts' CloudPerformers
  ([ADR-0035](0035-desktop-cloud-performer-owns-subscriptions.md),
  [ADR-0036](0036-browser-host-owns-subscription-state.md)).

## References

- `apps/web/src/cloud/mqtt-broker.ts` — `createMqttBrokerStore`, `BROKER_SETTINGS_SETTLE_MS`, `settleBrokerSettings`, `holdBrokerSettingsForm`, `brokerSettingsForm`.
- `apps/web/src/ai/llm-provider.ts` — `createLlmProviderStore`, `PROVIDER_SETTINGS_SETTLE_MS`, `settleLlmProviders`.
- `apps/web/src/cloud/cloud-capabilities.ts` — `hostSnapshotForFlowUpdate`, the status probe.
- `apps/web/src/cloud/connection-console/broker-console-session.ts`, `llm-console-session.ts`, `broker-transport.ts` — the console's flush and link key.
- `CONTEXT.md` § Settled broker settings.
