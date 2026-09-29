import { type Data, type Value, defaults } from "./figma.schema";
import {
  type BridgeVariable,
  type DesignTool,
  DESIGN_TOOLS,
  bridgeIdOf,
  useBridgeId,
  useDesignBridgeStore,
  useDesignToolsConnected,
  useDesignVariable,
  useDesignVariables,
} from "@/cloud/design-bridge";
import { useMqttBrokerStore } from "@/cloud/mqtt-broker";
import { Switch } from "@/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { CloudOffIcon, VariableIcon } from "lucide-react";
import { Position, useUpdateNodeInternals } from "@xyflow/react";
import { button } from "leva";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Handle as BaseHandle } from "../_base/handle";

const Handle = BaseHandle<"Figma">;
import {
  type BaseNode,
  NodeContainer,
  useDeleteHandles,
  useNodeControls,
  useNodeData,
} from "../_base/_base";
import { RgbaColorPicker } from "react-colorful";
import { useNodeValue } from "@/nodes/live/node-data";
import { type RGBA } from "../_base/_base.schema";
import { hostLimitation } from "../_base/browser-support";

const TOOL_LABEL: Record<DesignTool, string> = { figma: "Figma", penpot: "Penpot" };

const HANDLES = {
  BOOLEAN: ["true", "toggle", "false"],
  COLOR: ["red", "green", "blue", "opacity"],
  FLOAT: ["increment", "set", "decrement", "reset"],
  STRING: ["set"],
} as const;
const ALL_HANDLES = [...new Set(Object.values(HANDLES).flat())];

export function Figma(props: Props) {
  const connected = useDesignToolsConnected();
  const brokers = useMqttBrokerStore((s) => s.brokers);
  const broker = brokers.find((b) => b.id === props.data.brokerId);
  const source = props.data.source ?? "figma";

  // The node talks to the plugins over MQTT, so it inherits the browser's
  // WebSocket-only constraint (see `browser-support.ts`).
  const unreachableBroker =
    broker && hostLimitation({ kind: "broker", name: broker.name, url: broker.url })?.reason;

  const pluginError = props.data.variableId
    ? !connected[source] && `${TOOL_LABEL[source]} plugin is not connected`
    : !DESIGN_TOOLS.some((tool) => connected[tool]) && "No Figma or Penpot plugin is connected";

  const error = !brokers.length
    ? "No MQTT brokers configured"
    : !broker
      ? "Select a broker"
      : (unreachableBroker ?? (pluginError || undefined));

  return (
    <NodeContainer {...props} error={error}>
      <Value />
      <Settings />
      <FigmaHandles
        id={props.id}
        source={source}
        variableId={props.data.variableId}
        resolvedType={props.data.resolvedType}
      />
    </NodeContainer>
  );
}

function FigmaHandles(props: {
  id: string;
  source: DesignTool;
  variableId?: string;
  resolvedType?: Data["resolvedType"];
}) {
  const updateNodeInternals = useUpdateNodeInternals();
  const { variable } = useDesignVariable(props.source, props.variableId);
  // Fall back to the stored type so handles (and their edges) survive while
  // the plugin is closed, and so a template's edges attach before a variable
  // is picked.
  const type = variable?.resolvedType ?? props.resolvedType;

  useEffect(() => {
    if (!type) return;
    updateNodeInternals(props.id);
  }, [props.id, type, updateNodeInternals]);

  return (
    <>
      {type === "BOOLEAN" && (
        <>
          <Handle type="target" position={Position.Left} id="true" offset={-1} />
          <Handle type="target" position={Position.Left} id="toggle" />
          <Handle type="target" position={Position.Left} id="false" offset={1} />
        </>
      )}
      {type === "COLOR" && (
        <>
          <Handle type="target" position={Position.Left} id="red" hint="0-255" offset={-1.5} />
          <Handle type="target" position={Position.Left} id="green" hint="0-255" offset={-0.5} />
          <Handle type="target" position={Position.Left} id="blue" hint="0-255" offset={0.5} />
          <Handle type="target" position={Position.Left} id="opacity" hint="0-100" offset={1.5} />
        </>
      )}
      {type === "FLOAT" && (
        <>
          <Handle type="target" position={Position.Left} id="increment" offset={-1.5} />
          <Handle type="target" position={Position.Left} id="set" offset={-0.5} />
          <Handle type="target" position={Position.Left} id="decrement" offset={0.5} />
          <Handle type="target" position={Position.Left} id="reset" offset={1.5} />
        </>
      )}
      {type === "STRING" && <Handle type="target" position={Position.Left} id="set" />}
      <Handle type="source" position={Position.Right} id="change" />
    </>
  );
}

/** Variables from every connected tool, as `{ id, tool, variable }`, with
 *  labels that stay unique across tools and duplicate names. */
function useVariableOptions() {
  const variables = useDesignVariables();
  return useMemo(() => {
    const entries = DESIGN_TOOLS.flatMap((tool) =>
      Object.values(variables[tool] ?? {}).map((variable) => ({ tool, variable })),
    );
    const tools = new Set(entries.map((e) => e.tool));
    const options: Record<string, string> = {};
    const byId = new Map<string, { tool: DesignTool; variable: BridgeVariable }>();
    for (const entry of entries) {
      let label = tools.size > 1 ? `${entry.variable.name} (${TOOL_LABEL[entry.tool]})` : entry.variable.name;
      if (label in options) label = `${label} · ${entry.variable.id.slice(-6)}`;
      options[label] = entry.variable.id;
      byId.set(entry.variable.id, entry);
    }
    return { options, byId };
  }, [variables]);
}

function Settings() {
  const data = useNodeData<Data>();
  const deleteHandles = useDeleteHandles();
  const brokers = useMqttBrokerStore((s) => s.brokers);
  const bridgeId = useBridgeId();
  const { options: variableOptions, byId } = useVariableOptions();

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
        options: variableOptions,
        onChange: (id: string) => {
          const selected = byId.get(id);
          if (!selected) return;
          const keep: readonly string[] = HANDLES[selected.variable.resolvedType];
          deleteHandles(ALL_HANDLES.filter((handle) => !keep.includes(handle)));
          set({ resolvedType: selected.variable.resolvedType, source: selected.tool });
        },
      },
      source: {
        value: data.source!,
        label: "tool",
        options: [...DESIGN_TOOLS],
        render: () => false,
      },
      resolvedType: {
        value: data.resolvedType!,
        label: "type",
        options: ["BOOLEAN", "COLOR", "FLOAT", "STRING"],
        render: () => false,
      },
      "bridge ID": {
        value: bridgeId,
        hint: "Enter this Bridge ID in the Figma or Penpot plugin. Clear it to use the default.",
        onChange: (next: string) => {
          const state = useDesignBridgeStore.getState();
          if (next === bridgeIdOf(state)) return;
          state.setCustomBridgeId(next);
        },
      },
      "copy bridge ID": button(() => {
        navigator.clipboard.writeText(bridgeIdOf(useDesignBridgeStore.getState())).then(
          () => toast.success("Bridge ID copied"),
          () => toast.error("Could not copy the Bridge ID"),
        );
      }),
    },
    [variableOptions, brokers, bridgeId],
  );

  return <>{render()}</>;
}

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(data.initialValue!);
  const { variable } = useDesignVariable(data.source ?? "figma", data.variableId);
  const variables = useDesignVariables();
  const bridgeId = useBridgeId();

  const hasVariables = DESIGN_TOOLS.some((tool) => Object.keys(variables[tool] ?? {}).length > 0);
  if (!hasVariables)
    return (
      <section className="flex flex-col items-center gap-2">
        <CloudOffIcon className="text-muted-foreground" size={48} />
        <span className="text-muted-foreground text-xs">
          Bridge ID <code className="font-mono">{bridgeId}</code>
        </span>
      </section>
    );
  if (!variable) return <VariableIcon className="text-muted-foreground" size={48} />;

  switch (variable.resolvedType) {
    case "BOOLEAN":
      return (
        <section className="flex flex-col items-center gap-2">
          <Switch className="scale-150 border" checked={Boolean(value)} />
          <span className="text-muted-foreground text-xs">{variable.name}</span>
        </section>
      );
    case "FLOAT":
      return (
        <section className="flex flex-col items-center gap-1">
          <span className="text-4xl tabular-nums">{numberFormat.format(Number(value))}</span>
          <span className="text-muted-foreground text-xs">{variable.name}</span>
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
          <span className="text-muted-foreground text-xs">{variable.name}</span>
        </section>
      );
    case "COLOR": {
      // The runtime carries colors as 0–255 channels with a 0–1 alpha.
      const color = typeof value === "object" ? (value as RGBA) : { r: 0, g: 0, b: 0, a: 1 };
      return (
        <section className="flex flex-col items-center gap-1">
          <RgbaColorPicker color={{ r: color.r, g: color.g, b: color.b, a: color.a }} />
          <span className="text-muted-foreground text-xs">{variable.name}</span>
        </section>
      );
    }
    default:
      return (
        <section className="flex flex-col items-center gap-1">
          <div>Unknown type</div>
          <span className="text-muted-foreground text-xs">{variable.name}</span>
        </section>
      );
  }
}

type Props = BaseNode<Data>;
Figma.defaultProps = { data: defaults };
