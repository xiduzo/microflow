import { useBridgeSession, useNavigation } from "@microflow/design-bridge/react";
import { type ConnectionStatus, settingsProblems } from "@microflow/design-bridge/session";
import { ExternalLink, Heart, List, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { openLink, session } from "../channel";
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
  const { connection, studio, settingsErrors } = useBridgeSession(session);
  const { navigate } = useNavigation();
  // Stored settings that today's rules refuse are not connected with: say which, and why.
  const problems = settingsProblems(settingsErrors);

  return (
    <PageContent>
      <Row
        label={
          <>
            MQTT
            <StatusDot status={connection} />
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
      {problems.map((problem) => (
        // As the settings page shows a setting's error.
        <p key={problem} className="-mt-2 text-[11px] text-red-500">
          {problem}
        </p>
      ))}
      <Row
        label={
          <>
            Microflow studio
            <StatusDot status={studio} />
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
