import { Button, Icons } from "@fhb/ui";
import { createRoot } from "react-dom/client";
import { AutomaticSerialConnector } from "./components/AutomaticSerialConnector";

function App() {
  return (
    <>
      <nav className="space-x-4 flex justify-between">
        <AutomaticSerialConnector />
        <ol className="flex">
          <li>
            <Icons.UserIcon className="w-4 h-4" />
          </li>
        </ol>
      </nav>
      <aside>
        <h1>aside</h1>
        <Button variant="outline" size="icon">
          <Icons.Zap className="h-4 w-4" />
        </Button>
      </aside>
      <main>{/* <Test /> */}</main>
    </>
  );
}

const root = createRoot(document.body);
root.render(<App />);
