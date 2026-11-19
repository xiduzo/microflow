import { NodeHandles } from "../_base/node-handles";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { useNodeValue } from "@/nodes/live/node-data";
import {
  type Data,
  type RangeNumberData,
  type SingleNumberData,
  type TextData,
  type Value,
  dataSchema,
  defaults,
  numberDefaults,
  rangeDefaults,
  textDefaults,
} from "./compare.schema";
import { comparisonSummary } from "./compare.summary";
import { useMemo } from "react";
import { IconWithValue } from "../_base/icon-with-value";
import { ShieldCheckIcon, ShieldXIcon } from "lucide-react";
import { COMPARE_SUB_VALIDATORS, type CompareValidator } from "./compare.constants";

export function Compare(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <NodeHandles />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>(false);
  const data = useNodeData<Data>();

  const summary = useMemo(() => comparisonSummary(data), [data]);

  return (
    <IconWithValue
      icon={value ? ShieldCheckIcon : ShieldXIcon}
      iconClassName={value ? "text-green-500" : "text-red-500"}
      value={summary}
    />
  );
}

function Settings() {
  const data = useNodeData<Data>();

  const { render, setNodeData } = useNodeControls(
    {
      validator: {
        value: data.validator,
        options: {
          boolean: "boolean",
          number: "number",
          parity: "oddEven",
          range: "range",
          text: "text",
        },
        label: "validate that a",
        onChange: (event: CompareValidator) => {
          setNodeData({
            ...data,
            validator: event,
            subValidator: COMPARE_SUB_VALIDATORS[event].at(0),
          });
        },
      },
      subValidator: {
        label: "is",
        value: data.subValidator,
        options: COMPARE_SUB_VALIDATORS[data.validator],
        render: (get) => get("validator") !== "boolean",
      },
      // A node holds its validator's setting only once it is edited here;
      // until then each control shows the schema's default, which is what the
      // node checks.
      range: {
        value: { ...rangeDefaults.range, ...(data as RangeNumberData).range },
        label: "",
        joystick: false,
        render: (get) => get("validator") === "range",
      },
      number: {
        value: (data as SingleNumberData).number ?? numberDefaults.number,
        label: "",
        step: 1,
        render: (get) => get("validator") === "number",
      },
      text: {
        value: (data as TextData).text ?? textDefaults.text,
        label: "",
        render: (get) => get("validator") === "text",
      },
    },
    [data.validator],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Compare.defaultProps = { data: defaults };
