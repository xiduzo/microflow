import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { SignInForm } from "@/components/sign-in-form";
import { SignUpForm } from "@/components/sign-up-form";

export const Route = createFileRoute("/login")({
  component: RouteComponent,
});

function RouteComponent() {
  const [showSignUpForm, setShowsignupForm] = useState(false);

  return (
    <div className="flex items-center justify-center h-full">
      {showSignUpForm ? (
        <SignUpForm onSwitchToSignIn={() => setShowsignupForm(false)} />
      ) : (
        <SignInForm onSwitchToSignUp={() => setShowsignupForm(true)} />
      )}
    </div>
  );
}
