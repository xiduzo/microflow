import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { Mail } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import z from "zod";

import { authClient } from "@/lib/auth-client";

import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "./ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
} from "./ui/input-otp";

export function SignInForm() {
  const navigate = useNavigate({ from: "/" });
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"email" | "otp">("email");
  const [resendCooldown, setResendCooldown] = useState(0);
  const [isResending, setIsResending] = useState(false);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const handleResend = useCallback(async () => {
    if (resendCooldown > 0 || isResending) return;
    setIsResending(true);
    const { error } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setIsResending(false);
    if (error) {
      toast.error(error.message || "Failed to resend code");
      return;
    }
    setResendCooldown(30);
    toast.success("A new code has been sent to your email");
  }, [email, resendCooldown, isResending]);

  const emailForm = useForm({
    defaultValues: { email: "" },
    onSubmit: async ({ value }) => {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: value.email,
        type: "sign-in",
      });
      if (error) {
        toast.error(error.message || "Failed to send code");
        return;
      }
      setEmail(value.email);
      setStep("otp");
      setResendCooldown(30);
      toast.success("Check your email for the sign-in code");
    },
    validators: {
      onSubmit: z.object({
        email: z.email("Invalid email address"),
      }),
    },
  });

  const otpForm = useForm({
    defaultValues: { otp: "" },
    onSubmit: async ({ value }) => {
      const { error } = await authClient.signIn.emailOtp(
        { email, otp: value.otp },
        {
          onSuccess: () => {
            navigate({ to: "/" });
            toast.success("Signed in successfully");
          },
        }
      );
      if (error) {
        toast.error(error.message || "Invalid code");
      }
    },
    validators: {
      onSubmit: z.object({
        otp: z.string().min(1, "Enter the code from your email"),
      }),
    },
  });

  if (step === "otp") {
    return (
      <Card className="flex flex-col gap-6 mx-auto w-full mt-10 max-w-md">
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            We sent a sign-in code to <strong>{email}</strong>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              otpForm.handleSubmit();
            }}
          >
            <FieldGroup>
              <otpForm.Field name="otp">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>Sign-in code</FieldLabel>
                    <div className="flex flex-col gap-2 items-center justify-center">
                      <InputOTP
                        id={field.name}
                        value={field.state.value}
                        onChange={(value) => field.handleChange(value)}
                        onBlur={field.handleBlur}
                        maxLength={6}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        autoFocus
                      >
                        <InputOTPGroup>
                          <InputOTPSlot index={0} className="text-4xl size-14" />
                          <InputOTPSlot index={1} className="text-4xl size-14" />
                          <InputOTPSlot index={2} className="text-4xl size-14" />
                        </InputOTPGroup>
                        <InputOTPSeparator />
                        <InputOTPGroup>
                          <InputOTPSlot index={3} className="text-4xl size-14" />
                          <InputOTPSlot index={4} className="text-4xl size-14"/>
                          <InputOTPSlot index={5} className="text-4xl size-14"/>
                        </InputOTPGroup>
                      </InputOTP>
                    </div>
                    <FieldError errors={field.state.meta.errors} />
                  </Field>
                )}
              </otpForm.Field>

              <Field>
                <otpForm.Subscribe>
                  {(state) => (
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={!state.canSubmit || state.isSubmitting}
                    >
                      {state.isSubmitting ? "Verifying..." : "Sign In"}
                    </Button>
                  )}
                </otpForm.Subscribe>
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resendCooldown > 0 || isResending}
                  className="w-full text-center text-muted-foreground underline underline-offset-4 hover:text-primary text-xs mt-2 disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
                >
                  {isResending
                    ? "Resending..."
                    : resendCooldown > 0
                      ? `Resend code (${resendCooldown}s)`
                      : "Resend code"}
                </button>
                <button
                  type="button"
                  onClick={() => setStep("email")}
                  className="w-full text-center text-muted-foreground underline underline-offset-4 hover:text-primary text-xs mt-2"
                >
                  Use a different email
                </button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-6 mx-auto w-full mt-10 max-w-md">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          Enter your email and we&apos;ll send you a sign-in code
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            emailForm.handleSubmit();
          }}
        >
          <FieldGroup>
            <emailForm.Field name="email">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Email</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id={field.name}
                      name={field.name}
                      type="email"
                      placeholder="m@example.com"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      autoFocus
                    />
                    <InputGroupAddon>
                      <Mail />
                    </InputGroupAddon>
                  </InputGroup>
                  <FieldError errors={field.state.meta.errors} />
                </Field>
              )}
            </emailForm.Field>

            <Field>
              <emailForm.Subscribe>
                {(state) => (
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={!state.canSubmit || state.isSubmitting}
                  >
                    {state.isSubmitting ? "Sending..." : "Send sign-in code"}
                  </Button>
                )}
              </emailForm.Subscribe>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
