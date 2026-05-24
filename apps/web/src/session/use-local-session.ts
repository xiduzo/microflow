import { useEffect, useMemo } from "react";
import { acquireLocalSession, releaseSession } from "./session-registry";
import type { FlowSession } from "./flow-session";

export function useLocalSession(): FlowSession {
  const session = useMemo(() => acquireLocalSession(), []);
  useEffect(() => {
    return () => releaseSession(session.flowId);
  }, [session.flowId]);
  return session;
}
