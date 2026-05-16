import { useMemo } from "react";
import { useMqttStore, type ConnectionStatus } from "@microflow/mqtt";
import { Settings, List, ExternalLink, Heart } from "lucide-react";
import { PageContent } from "../components/PageLayout";
import { useNavigation } from "../hooks/use-navigation";
import { useAppStore } from "../stores/app";
import { sendToPlugin, messages } from "../../common/messages";

function StatusDot(props: { status?: ConnectionStatus }) {
  const color =
    props.status === "connected"
      ? "bg-green-500"
      : props.status === "connecting"
        ? "bg-amber-500"
        : props.status === "disconnected"
          ? "bg-red-500"
          : "bg-gray-400";

  return (
    <span
      className={`ml-1.5 inline-block h-2 w-2 rounded-full ${color}`}
      title={props.status ?? "not configured"}
    />
  );
}

function ConnectionRow(props: {
  label: string;
  status?: ConnectionStatus;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center text-[13px] text-gray-900 dark:text-gray-100">
        {props.label}
        <StatusDot status={props.status} />
      </div>
      <div className="flex gap-1">{props.actions}</div>
    </div>
  );
}

function IconButton(props: {
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      className="flex h-7 w-7 items-center justify-center rounded text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
    >
      {props.children}
    </button>
  );
}

export function Home() {
  const { status, connectedClients } = useMqttStore();
  const { mqttConfig } = useAppStore();
  const { navigate } = useNavigation();

  const studioStatus = useMemo(
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
            <IconButton onClick={() => navigate("variables")} title="Variables">
              <List size={16} />
            </IconButton>
            <IconButton onClick={() => navigate("mqtt")} title="MQTT settings">
              <Settings size={16} />
            </IconButton>
          </>
        }
      />
      <ConnectionRow
        label="Microflow studio"
        status={studioStatus}
        actions={
          <IconButton
            onClick={() =>
              sendToPlugin(
                messages.openLink("https://microflow.tech/"),
              )
            }
            title="Open Microflow Studio"
          >
            <ExternalLink size={16} />
          </IconButton>
        }
      />
      <div className="flex items-center justify-between py-1">
        <div className="flex items-center text-[13px] text-gray-900 dark:text-gray-100">
          Support Microflow
          <Heart
            size={10}
            className="ml-1.5 inline fill-rose-500 align-middle text-rose-500"
          />
        </div>
        <div className="flex gap-1">
          <IconButton
            onClick={() =>
              sendToPlugin(messages.openLink("https://microflow.tech/support"))
            }
            title="Support Microflow"
          >
            <ExternalLink size={16} />
          </IconButton>
        </div>
      </div>
      <div className="pt-2 text-center text-[11px] text-gray-400 dark:text-gray-500">
        Made with{" "}
        <Heart size={10} className="inline fill-current align-middle" /> by
        Xiduzo
      </div>
    </PageContent>
  );
}
