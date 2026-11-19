import { dataSchema, defaults, type Data, type Value } from "./llm.schema";
import { NodeHandles } from "../_base/node-handles";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { useLlmProviderStore } from "@/ai/llm-provider";
import { ProviderBadge } from "../_base/desktop-only-badge";
import { useEffect, useMemo, useState } from "react";
import { useNodeValue, useNodeHandleValue } from "@/nodes/live/node-data";
import { IconWithValue } from "../_base/icon-with-value";
import { BotIcon, BotMessageSquareIcon } from "lucide-react";
import { toast } from "sonner";

export function Llm(props: Props) {
  const providers = useLlmProviderStore((s) => s.providers);
  const hasProviders = providers.length > 0;
  const provider = providers.find((p) => p.id === props.data.providerId);
  const error = !hasProviders ? "No LLM providers configured" : !provider ? "Select a provider" : undefined;

  return (
    <NodeContainer {...props} error={error} badge={<ProviderBadge provider={provider} surface="node" />}>
      <Value />
      <Settings />
      <NodeHandles />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>("");
  const isThinking = useNodeHandleValue<boolean>("thinking", false);

  const hasResponse = value.length > 0;

  return (
    <IconWithValue
      icon={isThinking || hasResponse ? BotMessageSquareIcon : BotIcon}
      iconClassName={isThinking ? "animate-pulse" : ""}
      value={isThinking ? "Thinking..." : data.model || "No model selected"}
    />
  );
}

function Settings() {
  const [models, setModels] = useState<string[]>([]);
  const data = useNodeData<Data>();
  const providers = useLlmProviderStore((s) => s.providers);

  const providerOptions = useMemo(() => {
    const opts: Record<string, string> = { "Select provider...": "" };
    for (const p of providers) opts[p.name + (p.isDefault ? " (default)" : "")] = p.id;
    return opts;
  }, [providers]);

  const selectedProvider = providers.find((p) => p.id === data.providerId);

  const { render } = useNodeControls(
    {
      providerId: { value: data.providerId, options: providerOptions, label: "Provider" },
      model: { value: data.model, options: [...models] },
      system: { value: data.system, rows: 5 },
      prompt: { value: data.prompt, rows: 5 },
    },
    [models],
  );

  useEffect(() => {
    async function getModels() {
      const baseUrl = selectedProvider?.baseUrl ?? "http://localhost:11434";
      const providerName = selectedProvider?.name ?? "Ollama";

      // Only Ollama exposes /api/tags for model listing
      const isOllama = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("11434");
      if (!isOllama) return setModels([]);

      try {
        const response = await fetch(`${baseUrl}/api/tags`);
        const json = await response.json();
        setModels(json.models.map((model: { model: string }) => model.model));
      } catch {
        toast.warning(providerName, {
          description: "Failed to get models, make sure the base URL is correct and the server is running",
        });
      }
    }

    getModels();
  }, [data.providerId, selectedProvider]);

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Llm.defaultProps = { data: defaults };
