import { Icons } from "@fhb/ui";
import { createRoot } from "react-dom/client";
import { AutomaticSerialConnector } from "./render/components/AutomaticSerialConnector";
import { ComponentTabs } from "./render/components/react-flow/ComponentsTabs";
import { ReactFlowCanvas } from "./render/components/react-flow/ReactFlowCanvas";

function App() {
  return (
    <>
      <nav className="space-x-4 flex justify-between absolute z-10 right-0 m-3">
        <AutomaticSerialConnector />
        <ol className="flex">
          <li>
            <Icons.UserIcon className="w-4 h-4" />
          </li>
        </ol>
      </nav>
      <aside className="absolute z-10 m-3">
        <ComponentTabs />
      </aside>
      <main className="absolute w-screen h-screen">
        <ReactFlowCanvas />
      </main>
    </>
  );
}

const root = createRoot(document.body);
root.render(<App />);
