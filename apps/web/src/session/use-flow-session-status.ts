import { useSyncExternalStore } from "react";
import type { FlowSession } from "./flow-session";
import type { FlowSessionStatus } from "./session-status";
import { useFlowSession } from "./use-flow-session";

/** The Flow Session Status of `session`, re-rendering only when it changes. */
export function useSessionStatus(session: FlowSession): FlowSessionStatus {
  return useSyncExternalStore(session.status.subscribe, session.status.getSnapshot);
}

/** The Flow Session Status of the session in context. */
export function useFlowSessionStatus(): FlowSessionStatus {
  return useSessionStatus(useFlowSession());
}
