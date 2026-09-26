import { type BridgeSnapshotEntry, type ResolvedType, toWireId, topics } from "@microflow/design-bridge";
import { useAppStore, useCopyToClipboard } from "@microflow/design-bridge/react";
import {
  Check,
  ClipboardList,
  Hash,
  HelpCircle,
  Palette,
  Radio,
  RadioTower,
  ToggleLeft,
  Type,
} from "lucide-react";
import type { ReactNode } from "react";
import { openLink } from "../channel";
import { IconButton, PageContent, PageHeader } from "../components/PageLayout";
import { toast } from "../components/Toast";

const HELP_URL = "https://docs.microflow.tech/docs/microflow-penpot-plugin/variables";

const TYPE_ICONS: Record<ResolvedType, ReactNode> = {
  BOOLEAN: <ToggleLeft size={12} />,
  FLOAT: <Hash size={12} />,
  STRING: <Type size={12} />,
  COLOR: <Palette size={12} />,
};

export function Variables(props: { entries: BridgeSnapshotEntry[] }) {
  const uid = useAppStore((state) => state.mqttConfig?.uniqueId);

  return (
    <>
      <PageHeader
        title="Variables"
        end={
          <IconButton onClick={() => openLink(HELP_URL)} title="Help">
            <HelpCircle size={16} />
          </IconButton>
        }
      />
      <PageContent>
        {props.entries.length === 0 && (
          <div className="py-6 text-center">
            <ClipboardList size={32} className="mx-auto mb-3 opacity-30" />
            <p className="mb-2 text-[15px] font-semibold text-gray-900 dark:text-white">No tokens found</p>
            <p className="text-[12px] leading-relaxed text-gray-500 dark:text-gray-400">
              Add color, number or text tokens to the active <strong>MHB</strong> token set. Penpot has no
              boolean tokens: use a number token with 0 and 1 instead.
            </p>
          </div>
        )}
        {props.entries.map(({ variable }) => (
          <div key={variable.id} className="flex items-center justify-between gap-2 py-1">
            <div className="flex min-w-0 items-center gap-2 text-[13px] text-gray-900 dark:text-gray-100">
              <span
                className="flex w-[18px] shrink-0 justify-center text-gray-500 dark:text-gray-400"
                title={variable.resolvedType.toLowerCase()}
              >
                {TYPE_ICONS[variable.resolvedType]}
              </span>
              <span className="truncate" title={variable.name}>
                {variable.name}
              </span>
            </div>
            <div className="flex shrink-0 gap-0.5">
              <CopyButton
                title="Copy subscribe topic"
                text={uid && topics.value(uid, "penpot", toWireId(variable.id))}
                icon={<Radio size={12} />}
              />
              <CopyButton
                title="Copy publish topic"
                text={uid && topics.set(uid, toWireId(variable.id))}
                icon={<RadioTower size={12} />}
              />
            </div>
          </div>
        ))}
      </PageContent>
    </>
  );
}

function onCopied(ok: boolean) {
  toast(ok ? "Copied to clipboard" : "Could not copy to clipboard", { error: !ok });
}

function CopyButton(props: { title: string; text: string | undefined; icon: ReactNode }) {
  const [copied, copy] = useCopyToClipboard(onCopied);
  const { text } = props;

  return (
    <IconButton
      onClick={() => text && copy(text)}
      title={text ? props.title : "Set a Bridge ID in the MQTT settings first"}
      disabled={!text}
    >
      {text !== undefined && copied === text ? (
        <Check size={12} className="text-green-500" />
      ) : (
        props.icon
      )}
    </IconButton>
  );
}
