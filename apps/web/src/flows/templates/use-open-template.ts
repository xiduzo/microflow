import { useCallback, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { reportError } from "@/lib/report-error";
import { trpc } from "@/lib/trpc";
import { randomFlowColor } from "../flow-colors";
import { useOpenFlow } from "../use-open-flow";
import { openTemplate } from "./open-template";
import type { Template } from "./types";

/**
 * Start from a template (`openTemplate`), bound to this app. Signed in, the
 * template becomes a new flow in the account each time it is chosen; signed
 * out, it replaces the local flow. The user is told when a flow was created in
 * the account and when no flow could be opened.
 *
 * The returned function resolves to whether a flow was opened. While one
 * template is being opened a further call opens nothing and resolves to false,
 * so a second click on a card does not create a second flow in the account.
 *
 * `route` is the calling route's id, for error reports.
 */
export function useOpenTemplate(route: string): (template: Template) => Promise<boolean> {
  const openFlow = useOpenFlow();
  const queryClient = useQueryClient();
  const { mutateAsync: createFromImport } = useMutation(
    trpc.flow.createFromImport.mutationOptions(),
  );
  const opening = useRef(false);

  return useCallback(
    async (template) => {
      if (opening.current) return false;
      opening.current = true;
      try {
        const report = await openTemplate(template, {
          open: openFlow,
          createInAccount: (flow) => createFromImport({ ...flow, color: randomFlowColor() }),
        });

        if (report.failure !== undefined) {
          reportError(report.failure, { source: "action", route });
        }
        if (report.message) {
          const { level, title, description } = report.message;
          toast[level](title, { description });
        }
        if (report.where === "account") {
          queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
        }
        return report.where !== undefined;
      } finally {
        opening.current = false;
      }
    },
    [openFlow, createFromImport, queryClient, route],
  );
}
