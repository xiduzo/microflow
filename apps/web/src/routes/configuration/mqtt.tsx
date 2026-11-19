// Reachable in both hosts: since ADR-0009 the browser runs the Mqtt/Figma nodes
// itself (MQTT over WebSocket), and it reads the broker list straight from this
// store — so a web user who cannot open this page cannot use those nodes at all.
//
// The page is a console: the broker list is a rail, and the transcript below it
// is a real client — the desktop host's native `MqttManager` over IPC, or the
// browser's own mqtt.js connection. What you can do here is what a flow can do.
//
// The fields write to the store at every keystroke and show what was typed at
// once (`useBrokerSettingsForm`); the connections follow once the typing has
// stopped. Meanwhile the dot of the broker being edited shows `busy`.
import { createFileRoute } from "@tanstack/react-router";
import { AntennaIcon, PlusIcon, RadioIcon } from "lucide-react";

import {
  useBrokerSettingsForm,
  useMqttBrokerStore,
  type ConnectionStatus,
} from "@/cloud/mqtt-broker";
import { hostLimitation } from "@/nodes/_base/browser-support";
import {
  ConnectionConsole,
  ConsoleChip,
  ConsoleField,
  type ConnectionStatusTone,
} from "@/cloud/connection-console/connection-console";
import { useBrokerConsole } from "@/cloud/connection-console/use-console-session";
import { EmptyState } from "@/ui/states/empty-state";
import { Button } from "@/ui/button";

export const Route = createFileRoute("/configuration/mqtt")({
  component: MqttConfigPage,
});

function statusTone(status: ConnectionStatus | undefined): ConnectionStatusTone {
  if (status === "connected") return "ok";
  if (status === "connecting") return "busy";
  if (status === "error") return "error";
  return "idle";
}

function MqttConfigPage() {
  // The console before the form: when the page is left the console lets go of
  // its link first, and what is still typed settles after that. The other way
  // round the console would follow the settled settings with a link it is
  // about to close.
  const [{ selectedId, lines, subscriptions, commands }, session] = useBrokerConsole();
  const { brokers, statuses } = useBrokerSettingsForm();
  const addBroker = useMqttBrokerStore((state) => state.addBroker);
  const updateBroker = useMqttBrokerStore((state) => state.updateBroker);
  const deleteBroker = useMqttBrokerStore((state) => state.deleteBroker);
  const setDefaultBroker = useMqttBrokerStore((state) => state.setDefaultBroker);

  const broker = brokers.find((entry) => entry.id === selectedId);

  const browserUnreachable =
    broker !== undefined &&
    hostLimitation({ kind: "broker", name: broker.name, url: broker.url }) !== undefined;

  return (
    <ConnectionConsole
      title="mqtt"
      connections={brokers.map((entry) => ({
        id: entry.id,
        name: entry.name,
        subtitle: entry.url,
        isDefault: entry.isDefault,
        status: statusTone(statuses[entry.id]),
      }))}
      selectedId={selectedId}
      onSelect={session.select}
      addLabel="broker"
      onAdd={() =>
        session.select(addBroker({ name: "New broker", url: "", isDefault: brokers.length === 0 }))
      }
      lines={lines}
      onClear={() => session.run("clear")}
      commands={commands}
      onRun={session.run}
      placeholder="subscribe test/#"
      emptyState={
        brokers.length === 0 ? (
          <EmptyState
            icon={RadioIcon}
            title="No brokers yet"
            description="Add a broker to publish and subscribe from here — and from your flows."
          >
            <Button
              size="sm"
              onClick={() =>
                session.select(addBroker({ name: "New broker", url: "", isDefault: true }))
              }
            >
              <PlusIcon /> Add broker
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={AntennaIcon}
            title="Nothing has come through yet"
            description="Subscribe to a topic and anything published to it shows up here."
          >
            <code className="text-[11px] text-muted-foreground">
              subscribe test/# · publish test/hello world
            </code>
          </EmptyState>
        )
      }
      chips={
        subscriptions.length > 0 ? (
          <>
            <span className="text-[11px] text-muted-foreground self-center">listening:</span>
            {subscriptions.map((topic) => (
              <ConsoleChip key={topic} onRemove={() => session.run(`unsubscribe ${topic}`)} removeLabel={`Unsubscribe from ${topic}`}>
                {topic}
              </ConsoleChip>
            ))}
          </>
        ) : null
      }
      detail={
        broker && (
          <>
            <ConsoleField
              label="Name"
              value={broker.name}
              onChange={(event) => updateBroker(broker.id, { name: event.target.value })}
            />
            <ConsoleField
              label="URL"
              value={broker.url}
              placeholder="wss://broker.example.com:8883/mqtt"
              tone={browserUnreachable ? "warning" : undefined}
              hint={
                browserUnreachable
                  ? "A browser can only reach a broker over ws:// or wss://. This URL works in the desktop app, but not on the web."
                  : "ws:// or wss:// in the browser; any scheme in the desktop app."
              }
              onChange={(event) => updateBroker(broker.id, { url: event.target.value })}
              onBlur={session.reportConfigured}
            />
            <ConsoleField
              label="Username"
              value={broker.username ?? ""}
              placeholder="optional"
              onChange={(event) => updateBroker(broker.id, { username: event.target.value })}
            />
            <ConsoleField
              label="Password"
              type="password"
              value={broker.password ?? ""}
              placeholder="optional"
              onChange={(event) => updateBroker(broker.id, { password: event.target.value })}
            />
            <div className="flex items-center gap-3 pt-1 text-[11px]">
              {broker.isDefault ? (
                <span className="text-accent">default broker</span>
              ) : (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setDefaultBroker(broker.id)}
                >
                  make default
                </button>
              )}
              <button
                type="button"
                className="ml-auto text-muted-foreground hover:text-destructive"
                onClick={() => deleteBroker(broker.id)}
              >
                delete
              </button>
            </div>
          </>
        )
      }
    />
  );
}
