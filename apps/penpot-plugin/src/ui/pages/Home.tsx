import { useAppStore, useNavigation } from "@microflow/design-bridge/react";
import { type ConnectionStatus, useMqttStore } from "@microflow/mqtt";
import { ExternalLink, Heart, List, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { openLink } from "../channel";
import { IconButton, PageContent } from "../components/PageLayout";

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connected: "bg-green-500",
  connecting: "bg-amber-500",
  disconnected: "bg-red-500",
};

function StatusDot(props: { status?: ConnectionStatus }) {
  return (
    <span
      className={`ml-1.5 inline-block h-2 w-2 rounded-full ${props.status ? STATUS_COLORS[props.status] : "bg-gray-400"}`}
      title={props.status ?? "not configured"}
    />
  );
}

function Row(props: { label: ReactNode; actions: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center text-[13px] text-gray-900 dark:text-gray-100">
        {props.label}
      </div>
      <div className="flex gap-1">{props.actions}</div>
    </div>
  );
}

export function Home() {
  const { status, connectedClients } = useMqttStore();
  const { mqttConfig } = useAppStore();
  const { navigate } = useNavigation();
  const studioStatus = connectedClients.find(({ appName }) => appName === "app")?.status;

  return (
    <PageContent>
      <Row
        label={
          <>
            MQTT
            <StatusDot status={mqttConfig ? status : undefined} />
          </>
        }
        actions={
          <>
            <IconButton onClick={() => navigate("variables")} title="Variables">
              <List size={16} />
            </IconButton>
            <IconButton onClick={() => navigate("mqtt")} title="MQTT settings">
              <Settings size={16} />
            </IconButton>
          </>
        }
      />
      <Row
        label={
          <>
            Microflow studio
            <StatusDot status={studioStatus} />
          </>
        }
        actions={
          <IconButton onClick={() => openLink("https://microflow.tech/")} title="Open Microflow Studio">
            <ExternalLink size={16} />
          </IconButton>
        }
      />
      <Row
        label={
          <>
            Support Microflow
            <Heart size={10} className="ml-1.5 inline fill-rose-500 align-middle text-rose-500" />
          </>
        }
        actions={
          <IconButton onClick={() => openLink("https://microflow.tech/support")} title="Support Microflow">
            <ExternalLink size={16} />
          </IconButton>
        }
      />
      <div className="pt-2 text-center text-[11px] text-gray-400 dark:text-gray-500">
        Made with <Heart size={10} className="inline fill-current align-middle" /> by Xiduzo
      </div>
    </PageContent>
  );
}
