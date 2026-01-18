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
import { cn } from "@/lib/utils";
import { FLOW_COLORS } from "@/lib/flow-colors";

type Props = {
  flow: {
    id: string;
    name: string;
    description?: string | null;
    color?: string | null;
  };
  trigger?: React.ReactNode;
  onSuccess?: () => void;
};

export function EditFlowDialog({ flow, trigger, onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(flow.name);
  const [description, setDescription] = useState(flow.description ?? "");
  const [color, setColor] = useState(flow.color ?? FLOW_COLORS[0]);
  const [hoveredColor, setHoveredColor] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (open) {
      setName(flow.name);
      setDescription(flow.description ?? "");
      setColor(flow.color ?? FLOW_COLORS[0]);
    }
  }, [open, flow.name, flow.description, flow.color]);

  const updateMutation = useMutation({
    mutationFn: (data: {
      id: string;
      name?: string;
      description?: string;
      color?: string;
    }) => trpcClient.flow.update.mutate(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
      queryClient.invalidateQueries({
        queryKey: trpc.flow.get.queryKey({ id: flow.id }),
      });
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
      color: color,
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
            <DialogDescription>
              Update your flow's name, description, and color.
            </DialogDescription>
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
            <div className="grid gap-2">
              <Label>Color</Label>
              <div className="flex flex-wrap gap-2">
                {FLOW_COLORS.map((flowColor) => (
                  <button
                    key={flowColor}
                    type="button"
                    className={cn(
                      "w-8 h-8 rounded-full transition-all",
                      color === flowColor
                        ? "ring-2 ring-offset-2 ring-offset-background ring-primary scale-110"
                        : "hover:scale-105 hover:ring-1 hover:ring-offset-2 hover:ring-offset-background/5 hover:ring-primary/5"
                    )}
                    style={{ backgroundColor: flowColor }}
                    onClick={() => setColor(flowColor)}
                    onMouseEnter={() => setHoveredColor(flowColor)}
                    onMouseLeave={() => setHoveredColor(null)}
                    aria-label={`Select color ${flowColor}`}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || updateMutation.isPending}
            >
              {updateMutation.isPending && (
                <Loader2 className="size-4 mr-2 animate-spin" />
              )}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
