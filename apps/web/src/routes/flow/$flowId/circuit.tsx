import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSession } from "@/lib/auth-client";

export const Route = createFileRoute("/flow/$flowId/circuit")({
    beforeLoad: async ({ params }) => {
        const session = await getSession();

        if (params.flowId === "local") {
            return { session };
        }

        if (!session.data) {
            throw redirect({
                to: "/login",
                search: { redirect: `/${params.flowId}/circuit` },
            });
        }

        return { session };
    },
});
