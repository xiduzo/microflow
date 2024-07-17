import { Button, cva, Icons } from "@fhb/ui";
import { PageContent, PageHeader } from "../../components/Page";

import { ConnectionStatus, useMqtt } from "@fhb/mqtt/client";
import { useSetWindowSize } from "../../hooks/useSetWindowSize";

function ConnectionStatusBadge({
  title,
  status,
}: {
  title: string;
  status?: ConnectionStatus;
}) {
  return (
    <div className="flex items-center">
      {title}
      <span
        className={connectionStatusBadge({ status })}
        title={status}
        aria-busy={status !== "connected"}
      />
    </div>
  );
}

const connectionStatusBadge = cva(
  "ml-2 pointer-events-none w-2 h-2 rounded-full",
  {
    variants: {
      status: {
        undefined: "bg-yellow-500 text-yellow-900 animate-pulse",
        connected: "bg-green-500 text-green-900",
        connecting: "bg-green-400 text-green-800 animate-pulse",
        disconnected: "bg-red-500 text-red-900 animate-pulse",
      },
    },
  },
);

export function Home() {
  const { status, connectedClients } = useMqtt();
  useSetWindowSize({ width: 250, height: 250 });

  console.log("home", connectedClients);
  return (
    <>
      <PageHeader title="Home" />
      <PageContent className="flex flex-col space-y-3">
        <Button variant="outline">Manage Figma variables</Button>
        <section className="flex items-center justify-between">
          <ConnectionStatusBadge title="Mqtt" status={status} />
          <div>
            <Button variant="ghost" title="Mqtt settings">
              <Icons.ServerCog className="w-4 h-4" opacity="80%" />
            </Button>
          </div>
        </section>
        <section className="flex items-center justify-between">
          <div className="flex items-center">
            <ConnectionStatusBadge
              title="App"
              status={connectedClients.get("app")}
            />
          </div>
          <div className="space-x-1">
            <Button variant="ghost" title="How to use">
              <Icons.ExternalLink className="w-4 h-4" opacity="80%" />
            </Button>
            <Button variant="ghost" title="Serial settings">
              <Icons.Cog className="w-4 h-4" opacity="80%" />
            </Button>
          </div>
        </section>
        <h2 className="py-2 text-center opacity-60">made with ♥️ by xiduzo</h2>
      </PageContent>
    </>
  );
}
