import { FigmaProvider, MqttProvider } from "@fhb/mqtt/client";
import { ReactFlowProvider } from "@xyflow/react";
import { createRoot } from "react-dom/client";
import { ReactFlowComponent } from "./render/components/react-flow/ReactFlowCanvas";
import { BoardProvider } from "./render/providers/BoardProvider";
import { SignalerProvider } from "./render/providers/NodeSignaler";

export function App() {
  return (
    <MqttProvider appName="app">
      <FigmaProvider>
        <BoardProvider>
          <ReactFlowProvider>
            <SignalerProvider />
            <ReactFlowComponent />
          </ReactFlowProvider>
        </BoardProvider>
      </FigmaProvider>
    </MqttProvider>
  );
}

const root = createRoot(document.body);
root.render(<App />);
