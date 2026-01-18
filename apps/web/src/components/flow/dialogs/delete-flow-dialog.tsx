import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Trash2, WaypointsIcon } from "lucide-react";

import { trpc } from "@/utils/trpc";
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
import { toast } from "sonner";
import { useForm } from "@tanstack/react-form";
import { InputGroupAddon } from "@/components/ui/input-group";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";

type Props = {
  flow: { id: string; name: string };
  trigger?: React.ReactElement;
  onSuccess?: () => void;
};

export function DeleteFlowDialog({ flow, trigger, onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const form = useForm({
    defaultValues: {
      name: "",
    }
  });

  const deleteMutation = useMutation(
    trpc.flow.delete.mutationOptions({
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
        setOpen(false);
        form.reset();
        navigate({ to: "/" });
        toast.success("Flow deleted", {
          description: `${result.name} has been deleted`,
        });
        onSuccess?.();
      },
    })
  );

  return (
    <AlertDialog open={open} onOpenChange={open => {
      setOpen(open);
      if (open) return
      form.reset();
    }}>
      <AlertDialogTrigger
        render={
          trigger ?? (
            <Button
              size="sm"
              variant="destructive"
            />
          )
        }
      >
        {!trigger && <Trash2 className="size-4" />}
      </AlertDialogTrigger>
      <form>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{flow.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the flow
              and remove all collaborators.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <section className="flex justify-end">
            <form.Field name="name" >
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name + "-delete"}>
                    Type "<strong className="inline-block -mx-1.5">{flow.name}</strong>" to confirm deletion
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id={field.name + "-delete"}
                      name={field.name}
                      placeholder={flow.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      required
                    />
                    <InputGroupAddon>
                      <WaypointsIcon />
                    </InputGroupAddon>
                  </InputGroup>
                  {/* <FieldError errors={field.state.meta.errors} /> */}
                </Field>
              )}
            </form.Field>
          </section>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <form.Subscribe
              selector={(state) => state.values.name}
              children={(typedName) => (
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate({ id: flow.id })}
                  disabled={
                    deleteMutation.isPending || typedName !== flow.name
                  }
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {deleteMutation.isPending && (
                    <Loader2 className="size-4 mr-2 animate-spin" />
                  )}
                  Delete
                </AlertDialogAction>
              )}
            />
          </AlertDialogFooter>
        </AlertDialogContent>
      </form>
    </AlertDialog>
  );
}
