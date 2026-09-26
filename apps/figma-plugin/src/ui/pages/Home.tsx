/** @jsxImportSource preact */
import { IconButton } from "@create-figma-plugin/ui";
import { STUDIO } from "@microflow/design-bridge";
import { useAppStore, useNavigation } from "@microflow/design-bridge/react";
import { type ConnectionStatus, useMqttStore } from "@microflow/mqtt";
import { ExternalLink, Heart, Settings, Variable } from "lucide-react";
import { useMemo } from "preact/hooks";
import { openLink } from "../channel";
import { PageContent } from "../components/PageLayout";
import { useWindowSize } from "../hooks/use-window-size";

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
  useWindowSize({ width: 275, height: 220 });

  const appStatus = useMemo(
    () => connectedClients.find(({ appName }) => appName === STUDIO)?.status,
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
          <IconButton onClick={() => openLink("https://microflow.tech/")}>
            <ExternalLink size={16} />
          </IconButton>
        }
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", fontSize: "13px" }}>
          Support Microflow
          <Heart
            size={10}
            style={{
              marginLeft: 6,
              display: "inline",
              verticalAlign: "middle",
              fill: "#f43f5e",
              color: "#f43f5e",
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <IconButton onClick={() => openLink("https://microflow.tech/support")}>
            <ExternalLink size={16} />
          </IconButton>
        </div>
      </div>
      <div
        style={{
          textAlign: "center",
          fontSize: "11px",
          color: "var(--figma-color-text-secondary)",
          paddingTop: 8,
        }}
      >
        Made with{" "}
        <Heart
          size={10}
          style={{
            display: "inline",
            verticalAlign: "middle",
            fill: "currentColor",
          }}
        />{" "}
        by Xiduzo
      </div>
    </PageContent>
  );
}
