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
import { Switch } from "@/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { CloudOffIcon, VariableIcon } from "lucide-react";
import { button } from "leva";
import { useMemo } from "react";
import { toast } from "sonner";
import { NodeHandles } from "../_base/node-handles";
import { type BaseNode, NodeContainer, useNodeControls, useNodeData } from "../_base/_base";
import { RgbaColorPicker } from "react-colorful";
import { useNodeValue } from "@/nodes/live/node-data";
import { type RGBA } from "../_base/_base.schema";
import { useBrokerBinding } from "../_base/broker-binding";

const TOOL_LABEL: Record<DesignTool, string> = { figma: "Figma", penpot: "Penpot" };

export function Figma(props: Props) {
  const connected = useDesignToolsConnected();
  // The node talks to the plugins over MQTT, so what is wrong with its broker
  // is said before what is wrong with a plugin.
  const broker = useBrokerBinding(props.data.brokerId);
  const source = props.data.source ?? "figma";

  const pluginError = props.data.variableId
    ? !connected[source] && `${TOOL_LABEL[source]} plugin is not connected`
    : !DESIGN_TOOLS.some((tool) => connected[tool]) && "No Figma or Penpot plugin is connected";

  const error = broker.error ?? (pluginError || undefined);

  return (
    <NodeContainer {...props} error={error}>
      <Value />
      <Settings />
      <NodeHandles />
    </NodeContainer>
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
  const { control: brokerControl } = useBrokerBinding(data.brokerId);
  const bridgeId = useBridgeId();
  const { options: variableOptions, byId } = useVariableOptions();

  const { render, set } = useNodeControls(
    {
      brokerId: brokerControl,
      variableId: {
        label: "variable",
        value: data.variableId!,
        transient: false,
        options: variableOptions,
        onChange: (id: string) => {
          const selected = byId.get(id);
          if (!selected) return;
          // The node's Ports follow `resolvedType` (see `figma.handles.ts`).
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
    [variableOptions, brokerControl.options, bridgeId],
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
