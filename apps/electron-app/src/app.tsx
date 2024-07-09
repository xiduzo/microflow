import {
  Button,
  Icons,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@fhb/ui";
import { createRoot } from "react-dom/client";
import { AutomaticSerialConnector } from "./components/AutomaticSerialConnector";
import { Draggable } from "./components/react-flow/Draggable";
import { ReactFlowCanvas } from "./components/react-flow/ReactFlowCanvas";

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
        <Tabs
          defaultValue="components"
          className="bg-neutral-950/5 backdrop-blur-sm rounded-md p-2 z-50"
        >
          <TabsList>
            <TabsTrigger value="components">Components</TabsTrigger>
            <TabsTrigger value="password">Logic</TabsTrigger>
          </TabsList>
          <TabsContent value="components">
            <Draggable type="output">Output Node</Draggable>
            <Draggable type="default">Default Node</Draggable>
            <Draggable type="input">Input Node</Draggable>
            <Draggable type="button">Button Node</Draggable>
          </TabsContent>
          <TabsContent value="password">Change your password here.</TabsContent>
        </Tabs>
      </aside>
      <main className="absolute w-screen h-screen">
        <ReactFlowCanvas />
      </main>
    </>
  );
}

const root = createRoot(document.body);
root.render(<App />);

function sendData() {
  window.electron.ipcRenderer.send("ipc-fhb-data", "data");
}

function DataConnection() {
  return (
    <section className="mt-5">
      <Button onClick={sendData}>toggle</Button>
    </section>
  );
}
