import { ReactFlowProvider } from "@xyflow/react";
import { createRoot } from "react-dom/client";
import { ReactFlowComponent } from "./render/components/react-flow/ReactFlowCanvas";
import { BoardProvider } from "./render/providers/BoardProvider";
import { SignalerProvider } from "./render/providers/NodeSignaler";

export function App() {
  return (
    <BoardProvider>
      <ReactFlowProvider>
        <SignalerProvider />
        <ReactFlowComponent />
      </ReactFlowProvider>
    </BoardProvider>
  );
}

const root = createRoot(document.body);
root.render(<App />);
