import { usePins } from "@/stores/board";
import { useFlowDocument } from "@/stores/flow-store";
import { useFlowNodes, useFlowEdges } from "@/hooks/use-flow-document";
import { createFileRoute } from "@tanstack/react-router";
import { SchematicViewer } from "@tscircuit/schematic-viewer";
import { useMemo } from "react";
import { createCircuitJson } from "@/lib/schematic/circuit-json";

export const Route = createFileRoute("/$flowId/circuit")({
  component: RouteComponent,
});

function RouteComponent() {
  const flowDoc = useFlowDocument();
  const nodes = useFlowNodes(flowDoc);
  const edges = useFlowEdges(flowDoc);
  const pins = usePins();

  const circuitJson = useMemo(() => {
    console.log(nodes);
    const json = createCircuitJson(nodes, [
      ...pins,
      // { pin: 1, supportedModes: [], analogChannel: 0 },
      // { pin: 2, supportedModes: [], analogChannel: 0 },
      // { pin: 3, supportedModes: [], analogChannel: 0 },
      // { pin: 4, supportedModes: [], analogChannel: 0 },
      // { pin: 5, supportedModes: [], analogChannel: 0 },
      { pin: 6, supportedModes: [], analogChannel: 0 },
      // { pin: 7, supportedModes: [], analogChannel: 0 },
      // { pin: 8, supportedModes: [MODES.ANALOG, MODES.PWM], analogChannel: 1 },
      // { pin: 9, supportedModes: [], analogChannel: 0 },
      // { pin: 10, supportedModes: [], analogChannel: 0 },
      // { pin: 11, supportedModes: [], analogChannel: 0 },
      // { pin: 12, supportedModes: [], analogChannel: 0 },
      { pin: 13, supportedModes: [], analogChannel: 0 },
      // { pin: 14, supportedModes: [], analogChannel: 0 },
      // { pin: 15, supportedModes: [], analogChannel: 0 },
      // { pin: 16, supportedModes: [], analogChannel: 0 },
    ]);
    console.log(json);
    return json;
  }, [nodes, edges, pins]);

  return (
    <div className="w-full h-full">
      <SchematicViewer
        circuitJson={circuitJson}
        colorOverrides={{
          schematic: {
            background: "var(--background)",
            component_body: "var(--card-foreground)",
          },
        }}
        containerStyle={{
          width: "100%",
          height: "100%",
          borderRadius: "2rem",
        }}
      />
    </div>
  );
}
