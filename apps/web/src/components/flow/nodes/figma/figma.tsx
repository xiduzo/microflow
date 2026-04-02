import { type Data, type Value, dataSchema } from "./figma.schema";
import {
  useFigmaVariable,
  useFigmaVariables,
  useFigmaPluginConnected,
} from "@/stores/figma";
import { useMqttBrokerStore } from "@/stores/mqtt-broker";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CloudOffIcon, VariableIcon } from "lucide-react";
import { Position, useUpdateNodeInternals } from "@xyflow/react";
import { useEffect, useMemo } from "react";
import { Handle } from "../../handle";
import {
  type BaseNode,
  NodeContainer,
  useDeleteHandles,
  useNodeControls,
  useNodeData,
} from "../_base/_base";
import { RgbaColorPicker } from "react-colorful";
import { useNodeValue } from "@/stores/node-data";
import { type RGBA } from "../_base/_base.schema";

export function Figma(props: Props) {
  const pluginConnected = useFigmaPluginConnected();
  const brokers = useMqttBrokerStore((s) => s.brokers);
  const hasBroker = brokers.some((b) => b.id === props.data.brokerId);

  const error = !brokers.length
    ? "No MQTT brokers configured"
    : !hasBroker
      ? "Select a broker"
      : !pluginConnected
        ? "Figma plugin is not connected"
        : undefined;

  return (
    <NodeContainer
      {...props}
      error={error}
    >
      <Value />
      <Settings />
      <FigmaHandles variableId={props.data?.variableId} id={props.id} />
    </NodeContainer>
  );
}


function FigmaHandles(props: { variableId?: string; id: string }) {
  const updateNodeInternals = useUpdateNodeInternals();
  const { variable } = useFigmaVariable(props.variableId);

  useEffect(() => {
    if (!variable?.resolvedType) return;
    updateNodeInternals(props.id);
  }, [props.id, variable?.resolvedType, updateNodeInternals]);

  return (
    <>
      {variable?.resolvedType === "BOOLEAN" && (
        <>
          <Handle type="target" position={Position.Left} id="true" offset={-1} />
          <Handle type="target" position={Position.Left} id="toggle" />
          <Handle type="target" position={Position.Left} id="false" offset={1} />
          <Handle type="source" position={Position.Right} id="true" offset={-1} />
          <Handle type="source" position={Position.Right} id="false" offset={1} />
        </>
      )}
      {variable?.resolvedType === "COLOR" && (
        <>
          <Handle type="target" position={Position.Left} id="red" hint="0-255" offset={-1.5} />
          <Handle type="target" position={Position.Left} id="green" hint="0-255" offset={-0.5} />
          <Handle type="target" position={Position.Left} id="blue" hint="0-255" offset={0.5} />
          <Handle
            type="target"
            position={Position.Left}
            id="opacity"
            hint="0-100"
            offset={1.5}
          />
        </>
      )}
      {variable?.resolvedType === "FLOAT" && (
        <>
          <Handle type="target" position={Position.Left} id="increment" offset={-1.5} />
          <Handle type="target" position={Position.Left} id="set" offset={-0.5} />
          <Handle type="target" position={Position.Left} id="decrement" offset={0.5} />
          <Handle type="target" position={Position.Left} id="reset" offset={1.5} />
        </>
      )}
      {variable?.resolvedType === "STRING" && (
        <Handle type="target" position={Position.Left} id="set" />
      )}
      <Handle type="source" position={Position.Right} id="change" />
    </>
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const variables = useFigmaVariables();
  const deleteHandles = useDeleteHandles();
  const brokers = useMqttBrokerStore((s) => s.brokers);

  const brokerOptions = useMemo(() => {
    const options: Record<string, string> = { "Select broker...": "" };
    for (const broker of brokers) {
      const label = broker.name + (broker.isDefault ? " (default)" : "");
      options[label] = broker.id;
    }
    return options;
  }, [brokers]);

  const { render, set } = useNodeControls(
    {
      brokerId: {
        value: data.brokerId,
        options: brokerOptions,
        label: "Broker",
      },
      variableId: {
        label: "variable",
        value: data.variableId!,
        transient: false,
        options: Object.values(variables).reduce(
          (curr, variable) => {
            curr[variable.name] = variable.id;
            return curr;
          },
          {} as Record<string, string>,
        ),
        onChange: (event) => {
          const selectedVariableType = Array.from(Object.values(variables)).find(
            ({ id }) => id === event,
          )?.resolvedType;

          const booleanHandles = ["true", "toggle", "false"] as const;
          const colorHandles = ["red", "green", "blue", "opacity"] as const;
          const floatHandles = ["increment", "set", "decrement", "reset"] as const;
          const allHandles = [...booleanHandles, ...colorHandles, ...floatHandles] as const;

          switch (selectedVariableType) {
            case "BOOLEAN":
              deleteHandles(
                allHandles.filter((handle) => !["true", "toggle", "false"].includes(handle)),
              );
              break;
            case "COLOR":
              deleteHandles(
                allHandles.filter(
                  (handle) => !["red", "green", "blue", "opacity"].includes(handle),
                ),
              );
              break;
            case "FLOAT":
              deleteHandles(
                allHandles.filter((handle) => !["increment", "set", "decrement"].includes(handle)),
              );
              break;
            case "STRING":
              deleteHandles(allHandles.filter((handle) => !["set"].includes(handle)));
              break;
          }

          set({ resolvedType: selectedVariableType });
        },
      },
      resolvedType: {
        value: data.resolvedType!,
        label: "type",
        options: ["BOOLEAN", "COLOR", "FLOAT", "STRING"],
        render: () => false,
      },
      debounceTime: {
        value: data.debounceTime!,
        min: 10,
        max: 500,
        step: 10,
        label: "debounce (ms)",
      },
    },
    [variables, brokers],
  );

  return <>{render()}</>;
}

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(data.initialValue!);
  const { variable } = useFigmaVariable(data.variableId);
  const variables = useFigmaVariables();

  if (!Object.values(variables).length)
    return <CloudOffIcon className="text-muted-foreground" size={48} />;
  if (!variable) return <VariableIcon className="text-muted-foreground" size={48} />;

  switch (variable.resolvedType) {
    case "BOOLEAN":
      return (
        <section className="flex flex-col items-center gap-2">
          <Switch className="scale-150 border" checked={Boolean(value)} />
          <span className="text-muted-foreground text-xs">{variable?.name}</span>
        </section>
      );
    case "FLOAT":
      return (
        <section className="flex flex-col items-center gap-1">
          <span className="text-4xl tabular-nums">{numberFormat.format(Number(value))}</span>
          <span className="text-muted-foreground text-xs">{variable?.name}</span>
        </section>
      );
    case "STRING":
      return (
        <section className="flex flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger>
              <div className="-mx-8 max-w-48 max-h-32 text-wrap overflow-hidden pointer-events-auto">
                {String(value)}
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{String(value)}</TooltipContent>
          </Tooltip>
          <span className="text-muted-foreground text-xs">{variable?.name}</span>
        </section>
      );
    case "COLOR":
      return (
        <section className="flex flex-col items-center gap-1">
          <RgbaColorPicker
            color={{
              r: Math.round((value as RGBA).r * 255),
              g: Math.round((value as RGBA).g * 255),
              b: Math.round((value as RGBA).b * 255),
              a: (value as RGBA).a,
            }}
          />
          <span className="text-muted-foreground text-xs">{variable?.name}</span>
        </section>
      );
    default:
      return (
        <section className="flex flex-col items-center gap-1">
          <div>Unknown type</div>
          <span className="text-muted-foreground text-xs">{variable?.name}</span>
        </section>
      );
  }
}

type Props = BaseNode<Data>;
Figma.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "express",
    tags: ["action", "external"],
    label: "Figma",
    icon: "Figma",
    description:
      "Connect your flow to Figma design files to control colors, numbers, and text from your device",
  } satisfies Props["data"],
};
