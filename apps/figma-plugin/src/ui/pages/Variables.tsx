/** @jsxImportSource preact */
import { IconButton } from "@create-figma-plugin/ui";
import {
  type BridgeSnapshotEntry,
  type BridgeVariable,
  type ResolvedType,
  toWireId,
  topics,
} from "@microflow/design-bridge";
import { useAppStore, useCopyToClipboard } from "@microflow/design-bridge/react";
import { Check, ClipboardList, HelpCircle, Palette, Radio, RadioTower } from "lucide-react";
import type { ComponentChildren } from "preact";
import { openLink, showToast } from "../channel";
import { PageContent, PageHeader } from "../components/PageLayout";
import { useWindowSize } from "../hooks/use-window-size";

const HELP_URL =
  "https://docs.microflow.tech/docs/microflow-hardware-bridge/variables/manipulating";

export function Variables(props: { entries: BridgeSnapshotEntry[] }) {
  const { mqttConfig } = useAppStore();
  const uid = mqttConfig?.uniqueId || "BRIDGE_ID";
  const { entries } = props;

  useWindowSize({ width: 420, height: entries.length ? 550 : 300 });

  return (
    <>
      <PageHeader
        title="Variables"
        end={
          <IconButton onClick={() => openLink(HELP_URL)}>
            <HelpCircle size={16} />
          </IconButton>
        }
      />
      <PageContent>
        {!entries.length && (
          <div style={{ textAlign: "center", padding: "24px 12px" }}>
            <div style={{ fontSize: "32px", opacity: 0.3, marginBottom: 12 }}>
              <ClipboardList size={32} />
            </div>
            <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: 8 }}>
              No variables found
            </div>
            <div
              style={{
                fontSize: "12px",
                color: "var(--figma-color-text-secondary)",
                lineHeight: 1.5,
              }}
            >
              Variables in the{" "}
              <code
                style={{
                  padding: "1px 4px",
                  background: "#eab308",
                  borderRadius: 3,
                  color: "#fff",
                  fontSize: "11px",
                }}
              >
                MHB
              </code>{" "}
              collection will be linked automatically.
            </div>
          </div>
        )}
        {entries.map(({ variable }) => (
          <VariableRow key={variable.id} variable={variable} uid={uid} />
        ))}
      </PageContent>
    </>
  );
}

function VariableRow(props: { variable: BridgeVariable; uid: string }) {
  const { variable, uid } = props;
  const wireId = toWireId(variable.id);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "4px 0",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "13px" }}>
        <VariableIcon type={variable.resolvedType} />
        {variable.name}
      </div>
      <div style={{ display: "flex", gap: 2, opacity: 0.3 }}>
        <CopyButton
          title="Copy publish topic"
          text={topics.set(uid, wireId)}
          icon={<RadioTower size={12} />}
        />
        <CopyButton
          title="Copy subscribe topic"
          text={topics.value(uid, "figma", wireId)}
          icon={<Radio size={12} />}
        />
      </div>
    </div>
  );
}

function onCopied(ok: boolean) {
  if (ok) showToast("Copied to clipboard!");
  else showToast("Unable to copy to clipboard", { error: true });
}

function CopyButton(props: { text: string; title: string; icon: ComponentChildren }) {
  const [copied, copy] = useCopyToClipboard(onCopied);
  const isCopied = copied === props.text;

  return (
    <IconButton onClick={() => copy(props.text)}>
      <span
        title={props.title}
        style={{
          fontSize: "12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: isCopied ? "#22c55e" : undefined,
        }}
      >
        {isCopied ? <Check size={12} /> : props.icon}
      </span>
    </IconButton>
  );
}

function VariableIcon(props: { type: ResolvedType }) {
  const style = {
    fontSize: "11px",
    width: 18,
    textAlign: "center" as const,
    color: "var(--figma-color-text-secondary)",
  };

  switch (props.type) {
    case "BOOLEAN":
      return <span style={style}>⊘</span>;
    case "STRING":
      return <span style={style}>T</span>;
    case "FLOAT":
      return <span style={style}>#</span>;
    case "COLOR":
      return (
        <span style={style}>
          <Palette size={11} />
        </span>
      );
  }
}
