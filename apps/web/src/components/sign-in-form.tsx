import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { Mail } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import z from "zod";

import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "./ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "./ui/input-otp";

const OTP_LENGTH = 6;

type SignInFormProps = {
  className?: string;
  /** Render without the Card chrome, so a page can supply its own container. */
  bare?: boolean;
  title?: ReactNode;
  description?: ReactNode;
  /** Where to land after signing in. Same-origin paths only. */
  redirectTo?: string;
};

/** Only in-app paths, so `?redirect=` cannot bounce a user off-site. */
function safeRedirect(to: string | undefined) {
  return to && to.startsWith("/") && !to.startsWith("//") ? to : "/";
}

export function SignInForm({
  className,
  bare = false,
  title,
  description,
  redirectTo,
}: SignInFormProps) {
  const navigate = useNavigate({ from: "/" });
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"email" | "otp">("email");
  const [resendCooldown, setResendCooldown] = useState(0);
  const [isResending, setIsResending] = useState(false);

  // The OTP step is a single 6-digit field that submits itself once it is full,
  // so it does not need a form library.
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const otpRef = useRef<HTMLInputElement>(null);

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
    setOtp("");
    setOtpError(null);
    setResendCooldown(30);
    otpRef.current?.focus();
    toast.success("A new code has been sent to your email");
  }, [email, resendCooldown, isResending]);

  const verify = useCallback(
    async (code: string) => {
      if (code.length !== OTP_LENGTH || isVerifying) return;
      setIsVerifying(true);
      setOtpError(null);
      const { error } = await authClient.signIn.emailOtp(
        { email, otp: code },
        {
          onSuccess: () => {
            navigate({ to: safeRedirect(redirectTo) });
            toast.success("Signed in successfully");
          },
        }
      );
      setIsVerifying(false);
      if (error) {
        // Wrong code: clear the slots and put the caret back so the next
        // attempt does not start by deleting six digits.
        setOtp("");
        setOtpError(error.message || "That code is not valid");
        otpRef.current?.focus();
      }
    },
    [email, isVerifying, navigate, redirectTo]
  );

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
      setOtp("");
      setOtpError(null);
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

  const isOtpStep = step === "otp";

  const header = isOtpStep ? (
    <>
      <CardTitle>Check your email</CardTitle>
      <CardDescription>
        We sent a sign-in code to <strong>{email}</strong>
      </CardDescription>
    </>
  ) : (
    <>
      <CardTitle>{title ?? "Sign in"}</CardTitle>
      <CardDescription>
        {description ?? "Microflow sends a sign-in code to your email address."}
      </CardDescription>
    </>
  );

  const body = isOtpStep ? (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void verify(otp);
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="otp" className="sr-only">
            Sign-in code
          </FieldLabel>
          <div className="flex flex-col gap-2 items-center justify-center">
            <InputOTP
              ref={otpRef}
              id="otp"
              value={otp}
              onChange={(value) => {
                setOtp(value);
                if (otpError) setOtpError(null);
              }}
              onComplete={(value) => void verify(value)}
              maxLength={OTP_LENGTH}
              inputMode="numeric"
              autoComplete="one-time-code"
              disabled={isVerifying}
              aria-invalid={!!otpError}
              autoFocus
            >
              <InputOTPGroup>
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
              </InputOTPGroup>
              <InputOTPSeparator />
              <InputOTPGroup>
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>
          </div>
          {otpError && <FieldError errors={[{ message: otpError }]} />}
        </Field>

        <Field>
          <Button
            type="submit"
            className="w-full"
            disabled={otp.length !== OTP_LENGTH || isVerifying}
          >
            {isVerifying ? "Verifying..." : "Sign in"}
          </Button>
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
            onClick={() => {
              setStep("email");
              setOtp("");
              setOtpError(null);
            }}
            className="w-full text-center text-muted-foreground underline underline-offset-4 hover:text-primary text-xs mt-2"
          >
            Use a different email
          </button>
        </Field>
      </FieldGroup>
    </form>
  ) : (
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
  );

  if (bare) {
    return (
      <div className={cn("flex flex-col gap-4", className)}>
        <div className="grid gap-1">{header}</div>
        {body}
      </div>
    );
  }

  return (
    <Card className={cn("flex flex-col gap-6 w-full", className)}>
      <CardHeader>{header}</CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
