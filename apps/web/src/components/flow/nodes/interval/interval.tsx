import { dataSchema, defaults, type Data, type Value } from "./interval.schema";
import { Handle } from "../../handle";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { useNodeValue } from "@/stores/node-data";
import { MIN_INTERVAL_IN_MS } from "./interval.constants";

const numberFormat = new Intl.NumberFormat();

export function Interval(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="start" handleType="command" offset={-0.5} />
      <Handle type="target" position="left" id="stop" handleType="command" offset={0.5} />
      <Handle type="source" position="right" id="event" handleType="event" />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(0);

  return (
    <section className="flex flex-col text-center gap-1 items-center text-muted-foreground">
      <div className="tabular-nums">{numberFormat.format(Math.round(value))}</div>
      <div className="text-xs tabular-nums">each {numberFormat.format(data.interval / 1000)}s</div>
    </section>
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const { render } = useNodeControls({
    interval: {
      value: data.interval,
      min: MIN_INTERVAL_IN_MS,
      step: 100,
      label: "interval (ms)",
    },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Interval.defaultProps = { data: defaults };
