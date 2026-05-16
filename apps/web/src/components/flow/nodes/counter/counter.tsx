import { NodeContainer, useNodeControls, type BaseNode } from "../_base/_base";
import { useNodeValue } from "@/stores/node-data";
import { dataSchema, defaults, type Data, type Value } from "./counter.schema";
import { Handle as BaseHandle } from "../../handle";

const Handle = BaseHandle<"Counter">;

const numberFormat = new Intl.NumberFormat();

export function Counter(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="increment" title="+" handleType="command" offset={-1.5} />
      <Handle type="target" position="left" id="set" handleType="command" offset={-0.5} />
      <Handle type="target" position="left" id="decrement" title="-" handleType="command" offset={0.5} />
      <Handle type="target" position="left" id="reset" handleType="command" offset={1.5} />
      <Handle type="source" position="right" id="value" handleType="value" />
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
