import { useState, isValidElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { EarthIcon, Loader2, Share2, UserPlus, X, Copy, Check, Search, Mail } from "lucide-react";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";
import { track } from "@/lib/analytics";
import { isDesktop } from "@/lib/platform";
import { env } from "@microflow/env/web";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useForm } from "@tanstack/react-form";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { InputGroupAddon } from "@/components/ui/input-group";
import { useCopyToClipboard } from 'usehooks-ts'
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  flowId: string;
  flowName: string;
  trigger?: React.ReactNode;
  /** Control the dialog from elsewhere (e.g. a dropdown item); omit for a trigger-driven dialog. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function ShareFlowDialog({ flowId, flowName, trigger, open: controlledOpen, onOpenChange }: Props) {
  const [copiedText, copy] = useCopyToClipboard()

  const addCollaboratorMutation = useMutation(trpc.flow.addCollaboratorByEmail.mutationOptions({
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: trpc.flow.get.queryKey({ id: flowId }),
      });
      queryClient.invalidateQueries({
        queryKey: trpc.flow.pendingInvites.queryKey({ flowId }),
      });
      form.reset();
      track("flow_shared", { via: "collaborator" });
      toast.success(
        "invited" in data && data.invited
          ? "Invitation sent — they'll get access when they sign up"
          : "Collaborator added",
      );
    },
    onError: (error) => {
      toast.error(error.message);
    },
  }));

  const form = useForm({
    defaultValues: {
      email: "",
      role: "viewer",
    },
    onSubmit: ({ value }) => {
      addCollaboratorMutation.mutate({
        flowId,
        email: value.email,
        role: value.role as "viewer" | "editor",
      });
    },
  });

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = isControlled ? (onOpenChange ?? (() => {})) : setUncontrolledOpen;
  const queryClient = useQueryClient();

  // Always share the public web link. In the desktop build
  // window.location.origin is tauri://localhost, so prefer VITE_WEB_URL there.
  const webOrigin =
    (isDesktop() ? env.VITE_WEB_URL : undefined) ?? window.location.origin;
  const shareUrl = `${webOrigin}/flow/${flowId}`;

  const handleCopyLink = async () => {
    const copied = await copy(shareUrl);
    if (copied) {
      track("flow_shared", { via: "link" });
      toast.success("Link copied to clipboard");
      setTimeout(() => {
        copy("");
      }, 1500);
    } else {
      toast.error("Failed to copy link to clipboard");
    }
  };

  const defaultTrigger = (
    <Button size="sm" variant="outline">
      <Share2 className="size-4 mr-2" />
      Share
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen);
      if (isOpen) return
      form.reset();
    }}>
      {!isControlled && (
        <DialogTrigger render={isValidElement(trigger) ? trigger : defaultTrigger} />
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share "{flowName}"</DialogTitle>
          <DialogDescription>
            Invite others to view or edit this flow.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <InputGroup>
              <InputGroupInput value={shareUrl} readOnly />
              <InputGroupAddon align="inline-end" onClick={handleCopyLink}>
                {copiedText ? <Check /> : <Copy />}
              </InputGroupAddon>
            </InputGroup>
            {/* There is no link-scoped Flow Role: the link opens the flow for
                people who already have access, it does not grant any. */}
            <p className="text-xs text-muted-foreground">
              Link for people you've already added — it doesn't grant access on its own.
            </p>
          </div>
          {/* Add collaborator form */}
          <form className="space-y-3" onSubmit={e => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}>
            <FieldGroup className="grid grid-cols-12 gap-2 items-end">
              <form.Field name="email">
                {(field) => (
                  <Field className="col-span-6">
                    <FieldLabel htmlFor={field.name}>Add people</FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        id={field.name}
                        name={field.name}
                        type="email"
                        placeholder="m@example.com"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        required
                      />
                      <InputGroupAddon>
                        <Mail />
                      </InputGroupAddon>
                    </InputGroup>
                    <FieldError errors={field.state.meta.errors} />
                  </Field>
                )}
              </form.Field>
              <form.Field name="role">
                {(field) => (
                  <Field className="col-span-5">
                    <FieldLabel className="opacity-0" htmlFor={field.name}>Role</FieldLabel>
                    <Select
                      value={field.state.value}
                      onValueChange={(v) => field.handleChange(v as "viewer" | "editor")}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="viewer">Viewer</SelectItem>
                        <SelectItem value="editor">Editor</SelectItem>
                      </SelectContent>
                    </Select>
                    <FieldError errors={field.state.meta.errors} />
                  </Field>
                )}
              </form.Field>
              <Button size="icon" type="submit" disabled={!form.state.isValid || addCollaboratorMutation.isPending} className="col-span-1">
                {addCollaboratorMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <UserPlus className="size-4" />
                )}
              </Button>
            </FieldGroup>
          </form>

          <Separator />

          <PublishSection flowId={flowId} open={open} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Publish a frozen snapshot of the flow to the public community page.
 * Republish to push newer edits; unpublish to take it down.
 */
function PublishSection({ flowId, open }: { flowId: string; open: boolean }) {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState<string | null>(null);

  const { data: publishInfo } = useQuery({
    ...trpc.flow.publishInfo.queryOptions({ id: flowId }),
    enabled: open,
  });
  const isPublished = !!publishInfo?.publishedAt;

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: trpc.flow.publishInfo.queryKey({ id: flowId }),
    });
    queryClient.invalidateQueries({ queryKey: trpc.community.pathKey() });
  };

  const publishMutation = useMutation(
    trpc.flow.publish.mutationOptions({
      onSuccess: () => {
        invalidate();
        track("flow_shared", { via: "community" });
        toast.success(isPublished ? "Community flow updated" : "Published to community");
      },
      onError: (error) => toast.error(error.message),
    })
  );

  const unpublishMutation = useMutation(
    trpc.flow.unpublish.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast.success("Removed from community");
      },
      onError: (error) => toast.error(error.message),
    })
  );

  const pending = publishMutation.isPending || unpublishMutation.isPending;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <EarthIcon className="size-4" />
        <span className="text-sm font-medium">Community</span>
        {isPublished && publishInfo?.publishedAt && (
          <Link
            to="/community/$flowId"
            params={{ flowId }}
            className="ml-auto text-xs text-muted-foreground hover:underline"
          >
            Published {formatDistanceToNow(publishInfo.publishedAt, { addSuffix: true })}
          </Link>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {isPublished
          ? "Anyone can view and copy the published snapshot. Publishing again shares your latest changes."
          : "Share a snapshot of this flow publicly so anyone can view and copy it."}
      </p>
      <Textarea
        placeholder="What does this flow do? (optional)"
        value={description ?? publishInfo?.description ?? ""}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={500}
        rows={2}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            publishMutation.mutate({
              id: flowId,
              description: (description ?? publishInfo?.description ?? undefined) || undefined,
            })
          }
        >
          {publishMutation.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
          {isPublished ? "Publish update" : "Publish"}
        </Button>
        {isPublished && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => unpublishMutation.mutate({ id: flowId })}
          >
            Unpublish
          </Button>
        )}
      </div>
    </div>
  );
}
