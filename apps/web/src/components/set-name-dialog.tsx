import { useForm } from "@tanstack/react-form";
import { toast } from "sonner";
import z from "zod";

import { authClient } from "@/lib/auth-client";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "./ui/field";
import { InputGroup, InputGroupInput } from "./ui/input-group";

export function SetNameDialog() {
  const { data: session, refetch } = authClient.useSession();
  const open = !!session?.user && !session.user.name;

  const form = useForm({
    defaultValues: { name: "" },
    onSubmit: async ({ value }) => {
      const { error } = await authClient.updateUser({ name: value.name });
      if (error) {
        toast.error(error.message || "Failed to save name");
        return;
      }
      await refetch();
      toast.success("Welcome!");
    },
    validators: {
      onSubmit: z.object({
        name: z.string().min(2, "Name must be at least 2 characters"),
      }),
    },
  });

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Oops, we did not catch your name!</DialogTitle>
          <DialogDescription>
            Let us know what to call you so your collaborators can recognize you.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.Field name="name">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Your name</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id={field.name}
                      name={field.name}
                      type="text"
                      placeholder="Jane Doe"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      autoFocus
                    />
                  </InputGroup>
                  <FieldError errors={field.state.meta.errors} />
                </Field>
              )}
            </form.Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <form.Subscribe>
              {(state) => (
                <Button
                  type="submit"
                  disabled={!state.canSubmit || state.isSubmitting}
                >
                  {state.isSubmitting ? "Saving..." : "Continue"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
