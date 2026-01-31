import { Handle } from "../../handle";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { useNodeValue } from "@/stores/node-data";
import {
  type Data,
  type RangeNumberData,
  type SingleNumberData,
  type TextData,
  type Value,
  dataSchema,
} from "./compare.schema";
import { useMemo } from "react";
import { IconWithValue } from "../../icon-with-value";
import { ShieldCheckIcon, ShieldXIcon } from "lucide-react";
import { COMPARE_SUB_VALIDATORS, type CompareValidator } from "./compare.constants";

export function Compare(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="check" />
      <Handle type="source" position="right" id="true" offset={-1} />
      <Handle type="source" position="right" id="change" />
      <Handle type="source" position="right" id="false" offset={1} />
    </NodeContainer>
  );
}

const formatter = new Intl.NumberFormat("en-US");

function Value() {
  const value = useNodeValue<Value>(false);
  const data = useNodeData<Data>();

  const textValue = useMemo(() => {
    switch (data.validator) {
      case "boolean":
        return "boolean";
      case "number":
        return `is ${data.subValidator} ${formatter.format(data.number)}`;
      case "oddEven":
        return `is ${data.subValidator}`;
      case "range":
        return `is ${data.subValidator} ${formatter.format(
          data.range.min,
        )} and ${formatter.format(data.range.max)}`;
      case "text":
        return `is ${data.subValidator} "${data.text}"`;
      default:
        return "";
    }
  }, [data]);

  return (
    <IconWithValue
      icon={value ? ShieldCheckIcon : ShieldXIcon}
      iconClassName={value ? "text-green-500" : "text-red-500"}
      value={textValue}
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
      range: {
        value: (data as RangeNumberData).range ?? {
          min: 100,
          max: 500,
        },
        label: "",
        joystick: false,
        render: (get) => get("validator") === "range",
      },
      number: {
        value: (data as SingleNumberData).number ?? 0,
        label: "",
        step: 1,
        render: (get) => get("validator") === "number",
      },
      text: {
        value: (data as TextData).text ?? "",
        label: "",
        render: (get) => get("validator") === "text",
      },
    },
    [data.validator],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Compare.defaultProps = {
  data: {
    ...dataSchema.parse({ validator: "boolean" }),
    group: "decide",
    tags: ["trigger", "logic"],
    label: "Compare",
    icon: "ShieldCheckIcon",
    description:
      "Check if a value meets certain conditions and send different signals based on the result",
  } satisfies Props["data"],
};
