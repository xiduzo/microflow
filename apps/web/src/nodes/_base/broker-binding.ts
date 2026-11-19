// The broker binding: how a node that talks through an MQTT broker (Mqtt, the
// design variable node) is bound to one of the brokers the user configured.
// The node holds a broker's id in its `brokerId` setting; this module answers
// everything a node asks about that id — which broker it names, why the node
// cannot reach it, and the select that picks another.
//
// The Host Adapter half (the ids a flow's nodes depend on) is
// `./broker-binding.adapter.ts`: the Component Catalog imports adapters, and
// must not pull React, the broker store or the host checks in with them.

import { useMemo } from "react";
import { type MqttBrokerConfig, useMqttBrokerStore } from "@/cloud/mqtt-broker";
import { hostLimitation } from "./browser-support";

type Broker = Pick<MqttBrokerConfig, "id" | "name" | "url" | "isDefault">;

export type BrokerBinding = {
  /** The broker the node's `brokerId` names, when it names one. */
  broker: Broker | undefined;
  /**
   * Why the node cannot reach a broker, the most fundamental reason first: no
   * broker is configured, the node names none of them, or the one it names is
   * out of this host's reach (a browser speaks MQTT over a WebSocket only).
   * `undefined` when nothing stands in the way.
   */
  error: string | undefined;
  /**
   * The Leva select for the `brokerId` setting. Its options are
   * `{ [label]: broker id }`: the stored value is always the id, whatever the
   * label says. `options` keeps its identity for as long as the broker list
   * does, so it can be a dependency of `useNodeControls`.
   */
  control: { value: string; options: Record<string, string>; label: string };
};

/** The option a node shows while it names no broker; it stores no id. */
const UNBOUND = "Select broker...";

/**
 * `url` without the `user:password@` it may carry, with or without a scheme.
 * A password holds whatever the user typed, `@`, `/`, `?` and `#` included,
 * so everything from the start of the authority up to the last `@` goes. An
 * address whose path or query holds an `@` loses its host with it; no part of
 * a password ever reaches a label.
 */
function address(url: string): string {
  const trimmed = url.trim();
  const start = /^[a-z][a-z\d+.-]*:\/\//i.exec(trimmed)?.[0].length ?? 0;
  const at = trimmed.lastIndexOf("@");
  return at < start ? trimmed : trimmed.slice(0, start) + trimmed.slice(at + 1);
}

/**
 * A label per broker, each one distinct. Brokers that would read the same
 * (the same name) are told apart by their address, and by the tail of their id
 * when that is the same too.
 */
function brokerOptions(brokers: readonly Broker[]): Record<string, string> {
  const named = (broker: Broker) => broker.name + (broker.isDefault ? " (default)" : "");
  const options: Record<string, string> = { [UNBOUND]: "" };

  for (const broker of brokers) {
    const name = named(broker);
    const namesakes = brokers.filter((other) => named(other) === name);
    const at = address(broker.url);
    const candidates = [
      ...(namesakes.length === 1 ? [name] : []),
      ...(at !== "" && namesakes.filter((other) => address(other.url) === at).length === 1
        ? [`${name} · ${at}`]
        : []),
      `${name} · ${broker.id.slice(-6)}`,
    ];
    // An id is unique, so this label is taken only by a broker named exactly so.
    let label = candidates.find((candidate) => !Object.hasOwn(options, candidate)) ?? `${name} · ${broker.id}`;
    while (Object.hasOwn(options, label)) label = `${label} · ${broker.id}`;
    options[label] = broker.id;
  }
  return options;
}

const optionsOf = new WeakMap<readonly Broker[], Record<string, string>>();

/** `brokerOptions`, once per broker list. */
function cachedOptions(brokers: readonly Broker[]): Record<string, string> {
  let options = optionsOf.get(brokers);
  if (!options) {
    options = brokerOptions(brokers);
    optionsOf.set(brokers, options);
  }
  return options;
}

/** The binding of a node that holds `brokerId`, among the configured `brokers`. */
export function brokerBinding(brokers: readonly Broker[], brokerId: string): BrokerBinding {
  const broker = brokers.find((candidate) => candidate.id === brokerId);
  const error =
    brokers.length === 0
      ? "No MQTT brokers configured"
      : !broker
        ? "Select a broker"
        : hostLimitation({ kind: "broker", name: broker.name, url: broker.url })?.reason;

  return {
    broker,
    error,
    control: { value: brokerId, options: cachedOptions(brokers), label: "Broker" },
  };
}

/** `brokerBinding` against the brokers the user has configured. */
export function useBrokerBinding(brokerId: string): BrokerBinding {
  const brokers = useMqttBrokerStore((state) => state.brokers);
  return useMemo(() => brokerBinding(brokers, brokerId), [brokers, brokerId]);
}
