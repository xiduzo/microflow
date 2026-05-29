import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/flow/$flowId/code")({
    beforeLoad: async ({ params }) => {
        const session = await authClient.getSession();

        if (params.flowId === "local") {
            return { session };
        }

        if (!session.data) {
            throw redirect({
                to: "/login",
                search: { redirect: `/${params.flowId}/code` },
            });
        }

        return { session };
    },
});
