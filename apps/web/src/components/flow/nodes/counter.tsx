import { NodeContainer, useNodeControls, type BaseNode } from "./_base";
import { useNodeValue } from "@/stores/node-data";
import {
  dataSchema,
  type Data,
  type Value,
} from "@microflow/runtime/counter/counter.types";
import { Handle } from "../handle";
import { Tally5Icon } from "lucide-react";

const numberFormat = new Intl.NumberFormat();

export function Counter(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="increment" offset={-1.5} />
      <Handle type="target" position="left" id="set" offset={-0.5} />
      <Handle type="target" position="left" id="decrement" offset={0.5} />
      <Handle type="target" position="left" id="reset" offset={1.5} />
      <Handle type="source" position="right" id="change" />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>(0);

  return (
    <section className="text-4xl tabular-nums">
      {numberFormat.format(value)}
    </section>
  );
}

function Settings() {
  const { render } = useNodeControls({});

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Counter.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "flow",
    tags: ["control", "information"],
    label: "Counter",
    icon: Tally5Icon,
    description:
      "Keep track of a number that can be increased, decreased, set, or reset",
  } satisfies Props["data"],
};
