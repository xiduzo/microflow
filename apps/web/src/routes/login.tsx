import { createFileRoute, redirect } from "@tanstack/react-router";

import { SignInForm } from "@/components/sign-in-form";
import { getSession } from "@/lib/auth-client";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    const session = await getSession();
    if (session.data) {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div className="flex items-center justify-center h-full">
      <SignInForm />
    </div>
  );
}
