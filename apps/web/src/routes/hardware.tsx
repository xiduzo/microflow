import { createFileRoute } from "@tanstack/react-router";
import { HardwareControl } from "@/components/hardware/hardware-control";

export const Route = createFileRoute("/hardware")({
  component: HardwareRoute,
});

function HardwareRoute() {
  return (
    <div className="container mx-auto py-8">
      <HardwareControl />
    </div>
  );
}
