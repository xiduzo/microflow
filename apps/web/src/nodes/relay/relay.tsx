import { useNodeValue } from "@/nodes/live/node-data";
import { NodeHandles } from "../_base/node-handles";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { ZapIcon, ZapOffIcon } from "lucide-react";
import { type Value, type Data, dataSchema, defaults } from "./relay.schema";
import { MODES, usePins } from "@/board/board-store";
import { pinsToOptions } from "@/board/pin-label";

export function Relay(props: Props) {
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

  if (!value) return <ZapOffIcon className="text-muted-foreground" size={48} />;
  return <ZapIcon className="text-yellow-400" size={48} />;
}

function Settings() {
  const pins = usePins([MODES.OUTPUT]);
  const data = useNodeData<Data>();
  const { render } = useNodeControls(
    {
      pin: { value: data.pin, options: pinsToOptions(pins) },
      type: {
        value: data.type,
        options: {
          "Normally open (NO)": "NO",
          "Normally closed (NC)": "NC",
        },
      },
    },
    [pins],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Relay.defaultProps = { data: defaults };
