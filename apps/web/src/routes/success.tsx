import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { Link, createFileRoute, useSearch } from "@tanstack/react-router";
import { PartyPopperIcon } from "lucide-react";
import ReactConfetti from "react-confetti";

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
  return (
    <>
      <ReactConfetti
        style={{ position: "fixed", inset: 0, zIndex: 9999, pointerEvents: "none" }}
        width={window.innerWidth}
        height={window.innerHeight}
        recycle={false}
        numberOfPieces={500}
      />
      <div className="h-full w-full">
        <EmptyState
          title="Thank you for your support!"
          description="Your contribution keeps Microflow alive and growing. We truly appreciate you."
          icon={PartyPopperIcon}
        >
          <Link to="/">
            <Button>Back to my flows</Button>
          </Link>
        </EmptyState>
      </div>
    </>
  );
}
