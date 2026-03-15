import { createFileRoute } from "@tanstack/react-router";

import { SignInForm } from "@/components/sign-in-form";

export const Route = createFileRoute("/login")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div className="flex items-center justify-center h-full">
      <SignInForm />
    </div>
  );
}
