import { useEffect, useReducer } from "react";
import { acquireSession, peekSession, releaseSession } from "./session-registry";
import type { FlowSession } from "./flow-session";

/**
 * Hold the registry's session for `flowId` for the life of the component.
 *
 * Render only peeks (`peekSession` builds without a reference); the reference
 * is taken in the effect and released in its cleanup. The earlier shape took
 * the reference inside `useMemo`, i.e. during render: Strict Mode's double
 * render happened to balance it against the double effect, but any render
 * React discarded without committing (an interrupted transition, Suspense)
 * kept a reference no cleanup would ever release — a leaked socket.
 *
 * `build` is read once per `flowId`; changes to its inputs (user, token
 * reader) apply to the next session, not this one.
 */
export function useRegisteredSession(flowId: string, build: () => FlowSession): FlowSession {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const session = peekSession(flowId, build);

  useEffect(() => {
    // If the unclaimed grace ran out before commit, this builds a fresh
    // session; re-render so the tree picks it up.
    if (acquireSession(flowId, build) !== session) rerender();
    return () => releaseSession(flowId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  return session;
}
