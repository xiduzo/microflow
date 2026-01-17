import { dataSchema, type Data } from "./constant.schema";
import { Handle } from "../../handle";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base";
import { HashIcon } from "lucide-react";

const numberFormat = new Intl.NumberFormat();

export function Constant(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="source" position="right" id="output" />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();

  return <section className="text-4xl tabular-nums">{numberFormat.format(data.value)}</section>;
}

function Settings() {
  const data = useNodeData<Data>();
  const { render } = useNodeControls({
    value: { value: data.value, step: 1 },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Constant.defaultProps = {
  data: {
    ...dataSchema.parse({ value: 1337 }),
    group: "flow",
    tags: ["generator"],
    label: "Constant",
    icon: "HashIcon",
    description: "Provide a fixed number that stays the same and can be used by other nodes",
  } satisfies Props["data"],
};
