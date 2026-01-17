import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Plus } from "lucide-react";

import { trpc, trpcClient } from "@/utils/trpc";
import { useActiveFlowStore } from "@/stores/active-flow-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  trigger?: React.ReactNode;
  onSuccess?: (flowId: string) => void;
};

export function CreateFlowDialog({ trigger, onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const setActiveFlowId = useActiveFlowStore((s) => s.setActiveFlowId);

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      trpcClient.flow.create.mutate(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
      setActiveFlowId(result.id);
      setOpen(false);
      setName("");
      setDescription("");
      onSuccess?.(result.id);
      navigate({ to: "/flow/$flowId", params: { flowId: result.id } });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger ?? <Button size="sm" />}>
        {!trigger && (
          <>
            <Plus className="size-4 mr-2" />
            New Flow
          </>
        )}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create new flow</DialogTitle>
            <DialogDescription>
              Create a cloud flow to sync across devices and collaborate with others.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My awesome flow"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What's this flow about?"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || createMutation.isPending}>
              {createMutation.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
