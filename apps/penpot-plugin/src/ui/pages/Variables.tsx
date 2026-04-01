import { useState, type ReactNode } from "react";
import {
  ClipboardList,
  Radio,
  RadioTower,
  Check,
  Palette,
  HelpCircle,
} from "lucide-react";
import { type DesignToken, MSG, messages, sendToPlugin } from "../../common/messages";
import { PageContent, PageHeader } from "../components/PageLayout";
import { useMessageListener } from "../hooks/use-message-listener";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { useAppStore } from "../stores/app";
import { shortTokenId } from "../../common/mqtt-topics";

export function Variables() {
  const { mqttConfig } = useAppStore();
  const [tokens, setTokens] = useState<DesignToken[]>([]);

  useMessageListener<DesignToken[]>(MSG.GET_DESIGN_TOKENS, (t) => {
    if (t) setTokens(t);
  });

  return (
    <>
      <PageHeader
        title="Variables"
        end={
          <button
            type="button"
            onClick={() =>
              sendToPlugin(
                messages.openLink(
                  "https://docs.microflow.tech/docs/microflow-hardware-bridge/variables/manipulating#updating-variables-from-within-a-prototype",
                ),
              )
            }
            className="flex h-7 w-7 items-center justify-center rounded text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <HelpCircle size={16} />
          </button>
        }
      />
      <PageContent>
        {!tokens.length && (
          <div className="py-6 text-center">
            <ClipboardList size={32} className="mx-auto mb-3 opacity-30" />
            <p className="mb-2 text-[15px] font-semibold text-gray-900 dark:text-white">
              No variables found
            </p>
            <p className="text-[12px] leading-relaxed text-gray-500 dark:text-gray-400">
              Design tokens in your local library will be linked automatically.
            </p>
          </div>
        )}
        {tokens.map((token) => (
          <TokenRow
            key={token.path}
            token={token}
            uniqueId={mqttConfig?.uniqueId}
          />
        ))}
      </PageContent>
    </>
  );
}

function TokenRow(props: { token: DesignToken; uniqueId?: string }) {
  const { token, uniqueId } = props;
  const id = shortTokenId(token.path);

  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2 text-[13px] text-gray-900 dark:text-gray-100">
        <TokenIcon type={token.type} />
        {token.name}
      </div>
      <div className="flex gap-0.5 opacity-30">
        <CopyBtn
          title="Copy publish topic"
          text={`microflow/${uniqueId}/YOUR_APP_NAME/variable/${id}/set`}
          icon={<RadioTower size={12} />}
        />
        <CopyBtn
          title="Copy subscribe topic"
          text={`microflow/${uniqueId}/penpot/variable/${id}`}
          icon={<Radio size={12} />}
        />
      </div>
    </div>
  );
}

function CopyBtn(props: { text: string; title: string; icon: ReactNode }) {
  const [copiedValue, copy] = useCopyToClipboard();
  const isCopied = copiedValue === props.text;

  return (
    <button
      type="button"
      onClick={() => copy(props.text)}
      title={props.title}
      className={`flex h-7 w-7 items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${isCopied ? "text-green-500" : ""}`}
    >
      {isCopied ? <Check size={12} /> : props.icon}
    </button>
  );
}

function TokenIcon(props: { type: string }) {
  const base = "w-[18px] text-center text-[11px] text-gray-500 dark:text-gray-400";
  switch (props.type) {
    case "boolean":
      return <span className={base}>⊘</span>;
    case "string":
      return <span className={base}>T</span>;
    case "number":
      return <span className={base}>#</span>;
    case "color":
      return <span className={base}><Palette size={11} /></span>;
    default:
      return <span className={base}>?</span>;
  }
}
