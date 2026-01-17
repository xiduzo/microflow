import { useState, isValidElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Share2, UserPlus, X, Copy, Check } from "lucide-react";
import { toast } from "sonner";

import { trpc, trpcClient } from "@/utils/trpc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

type Props = {
  flowId: string;
  flowName: string;
  trigger?: React.ReactNode;
};

export function ShareFlowDialog({ flowId, flowName, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();

  const { data: flow, isLoading } = useQuery({
    ...trpc.flow.get.queryOptions({ id: flowId }),
    enabled: open,
  });

  const addCollaboratorMutation = useMutation({
    mutationFn: (data: { flowId: string; email: string; role: "viewer" | "editor" }) =>
      trpcClient.flow.addCollaboratorByEmail.mutate(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.flow.get.queryKey({ id: flowId }) });
      setEmail("");
      toast.success("Collaborator added");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const removeCollaboratorMutation = useMutation({
    mutationFn: (data: { flowId: string; userId: string }) =>
      trpcClient.flow.removeCollaborator.mutate(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.flow.get.queryKey({ id: flowId }) });
      toast.success("Collaborator removed");
    },
  });

  const handleAddCollaborator = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    addCollaboratorMutation.mutate({ flowId, email: email.trim(), role });
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/flow/${flowId}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const defaultTrigger = (
    <Button size="sm" variant="outline">
      <Share2 className="size-4 mr-2" />
      Share
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={isValidElement(trigger) ? trigger : defaultTrigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share "{flowName}"</DialogTitle>
          <DialogDescription>Invite others to view or edit this flow.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Copy link section */}
          <div className="flex items-center gap-2">
            <Input
              value={`${window.location.origin}/flow/${flowId}`}
              readOnly
              className="flex-1 text-sm"
            />
            <Button size="icon" variant="outline" onClick={handleCopyLink}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>

          {/* Add collaborator form */}
          <form onSubmit={handleAddCollaborator} className="space-y-3">
            <Label>Add people</Label>
            <div className="flex gap-2">
              <Input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1"
              />
              <Select value={role} onValueChange={(v) => setRole(v as "viewer" | "editor")}>
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="editor">Editor</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="submit"
                size="icon"
                disabled={!email.trim() || addCollaboratorMutation.isPending}
              >
                {addCollaboratorMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <UserPlus className="size-4" />
                )}
              </Button>
            </div>
          </form>

          {/* Collaborators list */}
          <div className="space-y-2">
            <Label>People with access</Label>
            {isLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-auto">
                {/* Owner */}
                {flow?.owner && (
                  <div className="flex items-center gap-3 p-2 rounded-lg bg-muted/50">
                    <Avatar className="size-8">
                      <AvatarImage src={flow.owner.image ?? undefined} />
                      <AvatarFallback>{flow.owner.name?.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{flow.owner.name}</p>
                    </div>
                    <Badge variant="secondary">Owner</Badge>
                  </div>
                )}

                {/* Collaborators */}
                {flow?.collaborators?.map((collab) => (
                  <div
                    key={collab.id}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50"
                  >
                    <Avatar className="size-8">
                      <AvatarImage src={collab.user.image ?? undefined} />
                      <AvatarFallback>{collab.user.name?.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{collab.user.name}</p>
                    </div>
                    <Badge variant="outline">{collab.role}</Badge>
                    {flow.isOwner && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        onClick={() =>
                          removeCollaboratorMutation.mutate({ flowId, userId: collab.userId })
                        }
                        disabled={removeCollaboratorMutation.isPending}
                      >
                        <X className="size-3" />
                      </Button>
                    )}
                  </div>
                ))}

                {flow?.collaborators?.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-2">
                    No collaborators yet
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
