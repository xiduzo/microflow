import {
  createCloudSession,
  type CreateCloudSessionOptions,
  type FlowSession,
} from "./flow-session";
import { useRegisteredSession } from "./use-registered-session";

export function useCloudSession(options: CreateCloudSessionOptions): FlowSession {
  return useRegisteredSession(options.flowId, () => createCloudSession(options));
}
