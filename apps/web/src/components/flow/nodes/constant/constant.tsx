import { dataSchema, defaults, type Data } from "./constant.schema";
import { Handle } from "../../handle";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";

const numberFormat = new Intl.NumberFormat();

export function Constant(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="source" position="right" id="value" handleType="value" />
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
Constant.defaultProps = { data: defaults };
