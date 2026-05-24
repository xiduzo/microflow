import { useEffect, useState } from "react";
import { Debouncer } from "@tanstack/react-pacer";
import { NODE_REGISTRY } from "@/components/flow/nodes/_REGISTRY";
import { useMqttBrokerStore } from "@/stores/mqtt-broker";
import { useFigmaStore } from "@/stores/figma";
import { useLlmProviderStore } from "@/stores/llm-provider";
import {
  FlowUpdateDispatcher,
  type DispatchScheduler,
  type HostSnapshot,
} from "./flow-update-dispatcher";
import { TauriFlowUpdateSender } from "./tauri-flow-update-sender";
import type { FlowSession } from "./flow-session";

const DEBOUNCE_MS = 500;

class DebounceScheduler implements DispatchScheduler {
  private readonly debouncer: Debouncer<(fn: () => void) => void>;

  constructor(waitMs: number) {
    this.debouncer = new Debouncer((fn: () => void) => fn(), { wait: waitMs });
  }

  schedule(callback: () => void): void {
    this.debouncer.maybeExecute(callback);
  }

  cancel(): void {
    // react-pacer's Debouncer doesn't expose an external cancel hook; the
    // dispatcher's `destroyed` flag in `dispatchNow` is the fail-safe.
  }
}

function readHostSnapshot(): HostSnapshot {
  return {
    brokers: useMqttBrokerStore.getState().brokers,
    providers: useLlmProviderStore.getState().providers,
    figma: { uniqueId: useFigmaStore.getState().uniqueId },
  };
}

/**
 * Mount one `FlowUpdateDispatcher` for the active `FlowSession`. Caller is
 * responsible for `isDesktop()` gating — the dispatcher itself contains
 * no platform branches, so it can run anywhere a `TauriFlowUpdateSender`
 * is wired up.
 */
export function useFlowUpdateDispatcher(session: FlowSession): void {
  const [dispatcher] = useState(
    () =>
      new FlowUpdateDispatcher(
        session,
        readHostSnapshot,
        new TauriFlowUpdateSender(),
        new DebounceScheduler(DEBOUNCE_MS),
        NODE_REGISTRY,
      ),
  );

  useEffect(() => () => dispatcher.destroy(), [dispatcher]);
}
