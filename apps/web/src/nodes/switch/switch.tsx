import { useNodeValue } from "@/nodes/live/node-data";
import { NodeHandles } from "../_base/node-handles";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { dataSchema, defaults, type Data, type Value } from "./switch.schema";
import { ToggleLeftIcon, ToggleRightIcon } from "lucide-react";
import { MODES, usePins } from "@/board/board-store";
import { pinsToOptions } from "@/board/pin-label";

export function Switch(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <NodeHandles />
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
