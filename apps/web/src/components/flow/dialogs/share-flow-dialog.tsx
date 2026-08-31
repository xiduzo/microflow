import { useState, isValidElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Share2, UserPlus, X, Copy, Check, Search, Mail } from "lucide-react";
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
