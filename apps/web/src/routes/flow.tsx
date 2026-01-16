import { ReactFlowCanvas } from '@/components/flow/ReactFlowCanvas';
import { authClient } from '@/lib/auth-client';
import { createFileRoute } from '@tanstack/react-router'
import { ReactFlowProvider } from '@xyflow/react';

export const Route = createFileRoute('/flow')({
  component: RouteComponent,
  beforeLoad: async () => {
    const session = await authClient.getSession();
    // if (!session.data) {
    //   redirect({
    //     to: "/login",
    //     throw: true,
    //   });
    // }
    const { data: customerState } = await authClient.customer.state();
    return { session, customerState };
  },
})

function RouteComponent() {
      const { session, customerState } = Route.useRouteContext();

      console.log({session, customerState})
    
  return (
        <ReactFlowProvider>
          <ReactFlowCanvas />
        </ReactFlowProvider>)
}
