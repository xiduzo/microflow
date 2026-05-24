import { useContext } from "react";
import { FlowSessionContext } from "./flow-session-context";
import type { FlowSession } from "./flow-session";

export function useFlowSession(): FlowSession {
  const session = useContext(FlowSessionContext);
  if (!session) {
    throw new Error("useFlowSession must be used inside a FlowSessionProvider");
  }
  return session;
}
