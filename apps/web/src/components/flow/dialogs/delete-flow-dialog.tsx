import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Trash2 } from "lucide-react";

import { trpc, trpcClient } from "@/utils/trpc";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type Props = {
  flow: { id: string; name: string };
  trigger?: React.ReactNode;
  onSuccess?: () => void;
};

export function DeleteFlowDialog({ flow, trigger, onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { activeFlowId, setActiveFlowId } = useActiveFlowStore();

  const deleteMutation = useMutation({
    mutationFn: () => trpcClient.flow.delete.mutate({ id: flow.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
      setOpen(false);
      // If we deleted the active flow, switch to local
      if (activeFlowId === flow.id) {
        setActiveFlowId("local");
        navigate({ to: "/flow/local" });
      }
      onSuccess?.();
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={trigger ?? <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" />}
      >
        {!trigger && <Trash2 className="size-4" />}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{flow.name}"?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will permanently delete the flow and remove all
            collaborators.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleteMutation.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
