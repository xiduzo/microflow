import { createLocalSession, type FlowSession } from "./flow-session";
import { useRegisteredSession } from "./use-registered-session";

export function useLocalSession(): FlowSession {
  return useRegisteredSession("local", createLocalSession);
}
