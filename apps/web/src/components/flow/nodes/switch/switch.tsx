import { useNodeValue } from "@/stores/node-data";
import { Handle as BaseHandle } from "../../handle";

const Handle = BaseHandle<"Switch">;
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { dataSchema, defaults, type Data, type Value } from "./switch.schema";
import { ToggleLeftIcon, ToggleRightIcon } from "lucide-react";
import { MODES, usePins } from "@/stores/board";
import { pinsToOptions } from "@/components/hardware/pin";

export function Switch(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="source" position="right" id="event" handleType="event" offset={-1} />
      <Handle type="source" position="right" id="true" handleType="state" />
      <Handle type="source" position="right" id="false" handleType="state" offset={1} />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>(false);

  if (!value) return <ToggleLeftIcon size={48} className="text-muted-foreground" />;
  return <ToggleRightIcon size={48} className="text-green-500" />;
}

function Settings() {
  const data = useNodeData<Data>();
  const pins = usePins([MODES.INPUT]);
  const { render } = useNodeControls(
    {
      pin: { value: data.pin, options: pinsToOptions(pins) },
      type: {
        value: data.type,
        options: {
          "normally closed (NC)": "NC",
          "normally open (NO)": "NO",
        },
      },
    },
    [pins],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Switch.defaultProps = { data: defaults };
