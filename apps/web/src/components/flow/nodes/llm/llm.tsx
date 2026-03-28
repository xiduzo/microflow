import { dataSchema, type Data, type Value } from "./llm.schema";
import { Handle } from "../../handle";
import {
  NodeContainer,
  useDeleteHandles,
  useNodeControls,
  useNodeData,
  useNodeId,
  type BaseNode,
} from "../_base/_base";
import { useLlmProviderStore } from "@/stores/llm-provider";
import { useEffect, useMemo, useRef, useState } from "react";
import { useUpdateNodeInternals } from "@xyflow/react";
import { useNodeValue } from "@/stores/node-data";
import { IconWithValue } from "../../icon-with-value";
import { BotIcon, BotMessageSquareIcon } from "lucide-react";
import { toast } from "sonner";

export function Llm(props: Props) {
  const providers = useLlmProviderStore((s) => s.providers);
  const hasProviders = providers.length > 0;
  const provider = providers.find((p) => p.id === props.data.providerId);
  const error = !hasProviders ? "No LLM providers configured" : !provider ? "Select a provider" : undefined;

  return (
    <NodeContainer {...props} error={error}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="trigger" handleType="command" />
      <Handle type="source" position="right" id="value" handleType="value" />
      <DynamicHandles />
    </NodeContainer>
  );
}

function DynamicHandles() {
  const data = useNodeData<Data>();
  const id = useNodeId();
  const previousHandles = useRef<string[]>([]);
  const deleteHandles = useDeleteHandles();

  const update = useUpdateNodeInternals();

  const handles = useMemo(() => {
    const matches = data.prompt?.match(/{{(.*?)}}/g) ?? [];
    return Array.from(
      new Set(matches.map((match) => match.replace("{{", "").replace("}}", ""))),
    ).filter(Boolean);
  }, [data.prompt]);

  useEffect(() => {
    const difference = handles.filter((handle) => !previousHandles.current.includes(handle));
    if (previousHandles.current.length) deleteHandles(difference);
    previousHandles.current = handles;
    update(id);
  }, [handles, id, update, deleteHandles]);

  return (
    <>
      {handles.slice(0, 7).map((handle, index) => (
        <Handle key={handle} type="target" position="bottom" id={handle} handleType="value" offset={index - (handles.length - 1) / 2} />
      ))}
    </>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(false);

  return (
    <IconWithValue
      icon={value ? BotMessageSquareIcon : BotIcon}
      iconClassName={value ? "animate-pulse" : ""}
      value={value ? "Thinking..." : data.model ? data.model : "No model selected"}
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
Llm.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "express",
    tags: ["action", "external", "stateful"],
    label: "LLM",
    icon: "BotMessageSquareIcon",
    description: "Use AI to generate text responses based on what you ask it",
  } satisfies Props["data"],
};
