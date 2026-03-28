/** @jsxImportSource preact */
import { useMqttStore, type ConnectionStatus } from "@microflow/mqtt";
import { useMemo } from "preact/hooks";
import { IconButton } from "@create-figma-plugin/ui";
import { Heart, Variable, Network, ExternalLink, Settings } from "lucide-react";
import { PageContent } from "../components/PageLayout";
import { useWindowSize } from "../hooks/use-window-size";
import { useNavigation } from "../hooks/use-navigation";
import { useAppStore } from "../stores/app";

function StatusDot(props: { status?: ConnectionStatus }) {
  const color =
    props.status === "connected"
      ? "#22c55e"
      : props.status === "connecting"
        ? "#f59e0b"
        : props.status === "disconnected"
          ? "#ef4444"
          : "#9ca3af";

  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        backgroundColor: color,
        marginLeft: 6,
      }}
      title={props.status ?? "not configured"}
    />
  );
}

function ConnectionRow(props: {
  label: string;
  status?: ConnectionStatus;
  actions?: preact.ComponentChildren;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "4px 0",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", fontSize: "13px" }}>
        {props.label}
        <StatusDot status={props.status} />
      </div>
      <div style={{ display: "flex", gap: 4 }}>{props.actions}</div>
    </div>
  );
}

export function Home() {
  const { status, connectedClients } = useMqttStore();
  const { mqttConfig } = useAppStore();
  const { navigate } = useNavigation();
  useWindowSize({ width: 275, height: 190 });

  const appStatus = useMemo(
    () => connectedClients.find(({ appName }) => appName === "app")?.status,
    [connectedClients],
  );

  return (
    <PageContent>
      <ConnectionRow
        label="MQTT"
        status={mqttConfig ? status : undefined}
        actions={
          <>
            <IconButton onClick={() => navigate("variables")}>
              <Variable size={16} />
            </IconButton>
            <IconButton onClick={() => navigate("mqtt")}>
              <Settings size={16} />
            </IconButton>
          </>
        }
      />
      <ConnectionRow
        label="Microflow studio"
        status={appStatus}
        actions={
          <IconButton
            onClick={() => window.open("https://microflow.vercel.app/", "_blank")}
          >
            <ExternalLink size={16} />
          </IconButton>
        }
      />
      <div
        style={{
          textAlign: "center",
          fontSize: "11px",
          color: "var(--figma-color-text-secondary)",
          paddingTop: 12,
        }}
      >
        Made with <Heart size={10} style={{ display: "inline", verticalAlign: "middle", fill: "currentColor" }} /> by Xiduzo
      </div>
    </PageContent>
  );
}
