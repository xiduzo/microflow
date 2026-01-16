import { dataSchema, type Data } from "./delay.schema";
import { Handle } from "../../handle";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "../_base";
import { IconWithValue } from "../../icon-with-value";
import { SnailIcon } from "lucide-react";

export function Delay(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="signal" />
      <Handle type="source" position="right" id="bang" />
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
Delay.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "flow",
    tags: ["control", "event"],
    label: "Delay",
    icon: "SnailIcon",
    description:
      "Wait for a specified amount of time before sending a signal forward",
  } satisfies Props["data"],
};
