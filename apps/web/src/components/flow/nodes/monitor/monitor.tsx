import { LevaPanel, monitor, useControls, useCreateStore } from "leva";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { Handle as BaseHandle } from "../../handle";

const Handle = BaseHandle<"Monitor">;
import { dataSchema, defaults, type Data, type Value } from "./monitor.schema";
import { useNodeValue } from "@/stores/node-data";
import { useEffect, useMemo, useRef } from "react";

export function Monitor(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="value" handleType="value" />
    </NodeContainer>
  );
}

const numberFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

function Value() {
  const data = useNodeData<Data>();
  const store = useCreateStore();
  const value = useNodeValue<Value>(data.type === "graph" ? 0 : "");

  const ref = useRef(value);

  useControls(
    {
      " ": monitor(ref, {
        graph: data.type === "graph",
        interval: 1000 / 60,
      }),
    },
    { store },
    [data.type],
  );
  useEffect(() => {
    ref.current = value;
  }, [value]);

  // Pretty-printed only when the value actually changes — never per render.
  // Malformed JSON falls back to the raw string instead of throwing.
  const prettyJson = useMemo(() => {
    if (typeof value !== "string" || !value.startsWith("{")) return null;
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }, [value]);

  if (data.type === "raw") {
    if (prettyJson !== null) {
      return (
        <section className="text-xs text-muted-foreground text-start grow p-4 max-w-md">
          <pre>{prettyJson}</pre>
        </section>
      );
    }

    if (typeof value === "number") {
      return <NumberValue value={value} />;
    }

    return <StringValue value={value} />;
  }

  return (
    <>
      <LevaPanel store={store} fill={true} flat titleBar={false} />
      <section className="absolute left-1/2 -translate-x-1/2 top-16">
        {typeof value === "number" ? <NumberValue value={value} /> : <StringValue value={value} />}
      </section>
    </>
  );
}

function NumberValue(props: { value: Value }) {
  return (
    <section className="text-xl tabular-nums max-w-lg text-muted-foreground whitespace-pre-line px-16">
      {numberFormat.format(Number(props.value))}
    </section>
  );
}

function StringValue(props: { value: Value }) {
  return (
    <section className="text-xl tabular-nums max-w-lg text-muted-foreground whitespace-pre-line px-16">
      {String(props.value)}
    </section>
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const { render } = useNodeControls({
    type: { value: data.type, options: ["graph", "raw"] },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Monitor.defaultProps = { data: defaults };
