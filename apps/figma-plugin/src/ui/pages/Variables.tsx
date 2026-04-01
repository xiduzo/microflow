/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import { IconButton } from "@create-figma-plugin/ui";
import { ClipboardList, Radio, RadioTower, Check, Palette, HelpCircle } from "lucide-react";
import { type FullVariable, MSG, messages, sendToPlugin } from "../../common/messages";
import { PageContent, PageHeader } from "../components/PageLayout";
import { useMessageListener } from "../hooks/use-message-listener";
import { useWindowSize } from "../hooks/use-window-size";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { useAppStore } from "../stores/app";
import { shortVarId } from "../../common/mqtt-topics";

export function Variables() {
  const { mqttConfig } = useAppStore();
  const [variables, setVariables] = useState<FullVariable[]>([]);

  useWindowSize({ width: 420, height: variables.length ? 550 : 300 });
  useMessageListener<FullVariable[]>(MSG.GET_LOCAL_VARIABLES, (v) => {
    if (v) setVariables(v);
  });

  return (
    <>
      <PageHeader
        title="Variables"
        end={
          <IconButton
            onClick={() =>
              sendToPlugin(
                messages.openLink(
                  "https://docs.microflow.tech/docs/microflow-hardware-bridge/variables/manipulating#updating-variables-from-within-a-prototype",
                ),
              )
            }
          >
            <HelpCircle size={16} />
          </IconButton>
        }
      />
      <PageContent>
        {!variables.length && (
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
        {variables.map((variable) => (
          <VariableRow
            key={variable.id}
            variable={variable}
            uniqueId={mqttConfig?.uniqueId}
          />
        ))}
      </PageContent>
    </>
  );
}

function VariableRow(props: { variable: FullVariable; uniqueId?: string }) {
  const { variable, uniqueId } = props;

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
        <CopyBtn
          title="Copy publish topic"
          text={`microflow/${uniqueId}/YOUR_APP_NAME/variable/${shortVarId(variable.id)}/set`}
          icon={<RadioTower size={12} />}
        />
        <CopyBtn
          title="Copy subscribe topic"
          text={`microflow/${uniqueId}/figma/variable/${shortVarId(variable.id)}`}
          icon={<Radio size={12} />}
        />
      </div>
    </div>
  );
}

function CopyBtn(props: { text: string; title: string; icon: preact.ComponentChildren }) {
  const [copiedValue, copy] = useCopyToClipboard();
  const isCopied = copiedValue === props.text;

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

function VariableIcon(props: { type: string }) {
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
      return <span style={style}><Palette size={11} /></span>;
    default:
      return <span style={style}>?</span>;
  }
}
