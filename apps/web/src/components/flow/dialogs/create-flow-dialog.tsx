import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Plus } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { useAppStore } from "@/stores/app";
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
import { cn } from "@/lib/utils";
import { FLOW_COLORS } from "@/lib/flow-colors";
import { useForm } from "@tanstack/react-form";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { toast } from "sonner";

type Props = {
  trigger?: React.ReactElement;
  onSuccess?: (flowId: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function CreateFlowDialog({ trigger, onSuccess, open: controlledOpen, onOpenChange: controlledOnOpenChange }: Props) {
  const form = useForm({
    defaultValues: {
      name: "",
      color: FLOW_COLORS[Math.floor(Math.random() * FLOW_COLORS.length)],
    },
    onSubmit: ({ value }) => createMutation.mutate(value),
  });

  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const setActiveFlowId = useAppStore((s) => s.setActiveFlowId);

  const createMutation = useMutation(trpc.flow.create.mutationOptions({
    onSuccess: (result) => {
      toast.success("Flow created", {
        description: `${result.name} has been created`,
      });
      queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
      setActiveFlowId(result.id);
      setOpen(false);
      form.reset();
      navigate({ to: "/flow/$flowId/graph", params: { flowId: result.id } });
    },
  }));

  return (
    <Dialog open={open} onOpenChange={open => {
      setOpen(open);
      if (open) return
      form.reset();
    }}>
      {trigger && (
        <DialogTrigger render={trigger} />
      )}
      <DialogContent>
        <form onSubmit={e => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}>
          <DialogHeader>
            <DialogTitle>Create new flow</DialogTitle>
            <DialogDescription>
              Create a flow to sync across devices and collaborate with others.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-3 py-6">
            <form.Field name="name">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Purpose of this flow</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id={field.name}
                      name={field.name}
                      placeholder="My awesome flow"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      required
                    />
                  </InputGroup>
                  <FieldError errors={field.state.meta.errors} />
                </Field>
              )}
            </form.Field>
            <form.Field name="color">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Quick identifier</FieldLabel>
                  <div className="flex flex-wrap gap-2">
                    {FLOW_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={cn(
                          "w-8 h-8 rounded-full transition-all",
                          field.state.value === color
                            ? "ring-2 ring-offset-2 ring-offset-background ring-primary scale-110"
                            : "hover:scale-105 hover:ring-1 hover:ring-offset-2 hover:ring-offset-background/5 hover:ring-primary/5"
                        )}
                        style={{ backgroundColor: color }}
                        onClick={() => field.handleChange(color as typeof field.state.value)}
                      />
                    ))}
                  </div>
                </Field>
              )}
            </form.Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <form.Subscribe
              children={() => (
                <Button type="submit" disabled={!form.state.isValid || createMutation.isPending}>
                  {createMutation.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
                  Create
                </Button>
              )}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
