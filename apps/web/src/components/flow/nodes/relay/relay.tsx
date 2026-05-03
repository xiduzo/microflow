import { useNodeValue } from "@/stores/node-data";
import { Handle } from "../../handle";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { ZapIcon, ZapOffIcon } from "lucide-react";
import { type Value, type Data, dataSchema, defaults } from "./relay.schema";
import { MODES, usePins } from "@/stores/board";
import { pinsToOptions } from "@/components/hardware/pin";

export function Relay(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="true" handleType="command" offset={-1} />
      <Handle type="target" position="left" id="toggle" handleType="command" />
      <Handle type="target" position="left" id="false" handleType="command" offset={1} />
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
