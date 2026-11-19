import { NodeContainer, useNodeControls, type BaseNode } from "../_base/_base";
import { useNodeValue } from "@/nodes/live/node-data";
import { dataSchema, defaults, type Data, type Value } from "./counter.schema";
import { NodeHandles } from "../_base/node-handles";

const numberFormat = new Intl.NumberFormat();

export function Counter(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <NodeHandles />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>(0);

  return <section className="text-4xl tabular-nums">{numberFormat.format(value)}</section>;
}

function Settings() {
  const { render } = useNodeControls({});

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Counter.defaultProps = { data: defaults };
