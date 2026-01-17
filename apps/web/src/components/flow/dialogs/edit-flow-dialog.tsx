import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil } from "lucide-react";

import { trpc, trpcClient } from "@/utils/trpc";
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
  flow: { id: string; name: string; description?: string | null };
  trigger?: React.ReactNode;
  onSuccess?: () => void;
};

export function EditFlowDialog({ flow, trigger, onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(flow.name);
  const [description, setDescription] = useState(flow.description ?? "");
  const queryClient = useQueryClient();

  useEffect(() => {
    if (open) {
      setName(flow.name);
      setDescription(flow.description ?? "");
    }
  }, [open, flow.name, flow.description]);

  const updateMutation = useMutation({
    mutationFn: (data: { id: string; name?: string; description?: string }) =>
      trpcClient.flow.update.mutate(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
      queryClient.invalidateQueries({ queryKey: trpc.flow.get.queryKey({ id: flow.id }) });
      setOpen(false);
      onSuccess?.();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    updateMutation.mutate({
      id: flow.id,
      name: name.trim(),
      description: description.trim() || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger ?? <Button size="sm" variant="ghost" />}>
        {!trigger && <Pencil className="size-4" />}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit flow</DialogTitle>
            <DialogDescription>Update your flow's name and description.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My awesome flow"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-description">Description (optional)</Label>
              <Textarea
                id="edit-description"
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
            <Button type="submit" disabled={!name.trim() || updateMutation.isPending}>
              {updateMutation.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
