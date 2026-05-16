import { createFileRoute, useSearch } from "@tanstack/react-router";

export const Route = createFileRoute("/success")({
  component: SuccessPage,
  validateSearch: (search: Record<string, unknown>) => ({
    checkout_id: typeof search.checkout_id === "string" ? search.checkout_id : undefined,
    customer_session_token:
      typeof search.customer_session_token === "string"
        ? search.customer_session_token
        : undefined,
  }),
});

function SuccessPage() {
  const { checkout_id, customer_session_token } = useSearch({ from: "/success" });

  return (
    <div className="container mx-auto px-4 py-8">
      <h1>Payment Successful!</h1>
      {checkout_id && <p>Checkout ID: {checkout_id}</p>}
      {customer_session_token && <p>Session: {customer_session_token}</p>}
    </div>
  );
}
