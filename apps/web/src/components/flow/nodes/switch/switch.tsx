import { useNodeValue } from "@/stores/node-data";
import { Handle } from "../../handle";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "../_base";
import { dataSchema, type Data, type Value } from "./switch.schema";
import { ToggleLeftIcon, ToggleRightIcon } from "lucide-react";
import { MODES, usePins } from "@/stores/board";
import { reducePinsToOptions } from "@/components/hardware/pin";

export function Switch(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle
        type="source"
        position="right"
        id="open"
        title="active"
        offset={-1}
      />
      <Handle type="source" position="right" id="change" />
      <Handle
        type="source"
        position="right"
        id="close"
        title="inactive"
        offset={1}
      />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>(false);

  if (!value)
    return <ToggleLeftIcon size={48} className="text-muted-foreground" />;
  return <ToggleRightIcon size={48} className="text-green-500" />;
}

function Settings() {
  const data = useNodeData<Data>();
  const pins = usePins([MODES.INPUT]);
  const { render } = useNodeControls(
    {
      pin: { value: data.pin, options: pins.reduce(reducePinsToOptions, {}) },
      type: {
        value: data.type,
        options: {
          "normally closed (NC)": "NC",
          "normally open (NO)": "NO",
        },
      },
    },
    [pins]
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Switch.defaultProps = {
  data: {
    ...dataSchema.parse({ type: "NC" }),
    group: "hardware",
    icon: "ToggleLeftIcon",
    label: "Switch",
    tags: ["input", "digital"],
    description: "Detect when a physical switch is turned on or off",
  } satisfies Props["data"],
};
