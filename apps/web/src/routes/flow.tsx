import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/flow")({
  component: FlowLayout,
  beforeLoad: async ({ location }) => {
    // If accessing /flow directly, redirect to /flow/local
    if (location.pathname === "/flow") {
      throw redirect({ to: "/flow/local" });
    }
  },
});

function FlowLayout() {
  return <Outlet />;
}
