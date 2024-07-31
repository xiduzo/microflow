import { FigmaProvider, MqttProvider } from "@fhb/mqtt/client";
import { ReactFlowProvider } from "@xyflow/react";
import { createRoot } from "react-dom/client";
import { adjectives, animals, uniqueNamesGenerator } from "unique-names-generator";
import { useLocalStorage } from "usehooks-ts";
import { ReactFlowComponent } from "./render/components/react-flow/ReactFlowCanvas";
import { BoardProvider } from "./render/providers/BoardProvider";
import { SignalerProvider } from "./render/providers/NodeSignaler";

export function App() {
  const [identifier] = useLocalStorage("identifier", uniqueNamesGenerator({ dictionaries: [adjectives, animals] }))

  return (
    <MqttProvider appName="app" uniqueId={identifier}>
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
