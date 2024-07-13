import { ReactFlowProvider } from "@xyflow/react";
import { createRoot } from "react-dom/client";
import { ReactFlowComponent } from "./render/components/react-flow/ReactFlowCanvas";
import { SignalerProvider } from "./render/providers/NodeSignaler";

export function App() {
  return (
    <ReactFlowProvider>
      <SignalerProvider />
      <ReactFlowComponent />
    </ReactFlowProvider>
  );
}

const root = createRoot(document.body);
root.render(<App />);
