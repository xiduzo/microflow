import { dataSchema, defaults, type Data } from "./delay.schema";
import { NodeHandles } from "../_base/node-handles";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { IconWithValue } from "../../icon-with-value";
import { SnailIcon } from "lucide-react";

export function Delay(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <NodeHandles
        instance="Delay"
        portOverrides={{ trigger: { handleType: "command" } }}
        emitOverrides={{ event: { handleType: "event" } }}
      />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();

  return (
    <IconWithValue
      icon={SnailIcon}
      value={`${data.forgetPrevious ? "debounced " : ""}${data.delay / 1000}`}
      suffix="s"
    />
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const { render } = useNodeControls({
    delay: {
      min: 100,
      step: 100,
      value: data.delay,
      label: "delay (ms)",
    },
    forgetPrevious: {
      value: data.forgetPrevious,
      label: "debounce",
    },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Delay.defaultProps = { data: defaults };
