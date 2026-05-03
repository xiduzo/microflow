import { type Data, dataSchema, defaults } from "./calculate.schema";
import { NodeContainer, useNodeData, useNodeControls, type BaseNode } from "../_base/_base";
import { Handle } from "../../handle";
import {
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  ChevronDownIcon,
  ChevronsUpDownIcon,
  ChevronUpIcon,
  CircleHelpIcon,
  DivideIcon,
  MinusIcon,
  PercentIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useMemo } from "react";

export function Calculate(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />

      <Handle type="target" position="left" id="value" handleType="value" />
      <Handle type="source" position="right" id="value" handleType="value" />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();

  const Icon = useMemo(() => {
    switch (data.function) {
      case "add":
        return PlusIcon;
      case "subtract":
        return MinusIcon;
      case "multiply":
        return XIcon;
      case "divide":
        return DivideIcon;
      case "modulo":
        return PercentIcon;
      case "max":
        return ArrowUpToLineIcon;
      case "min":
        return ArrowDownToLineIcon;
      case "ceil":
        return ChevronUpIcon;
      case "floor":
        return ChevronDownIcon;
      case "round":
        return ChevronsUpDownIcon;
      default:
        return CircleHelpIcon;
    }
  }, [data.function]);

  return <Icon className="text-muted-foreground" size={48} />;
}

function Settings() {
  const data = useNodeData<Data>();
  const { render } = useNodeControls({
    function: {
      value: data.function,
      options: {
        addition: "add",
        subtraction: "subtract",
        multiplication: "multiply",
        division: "divide",
        modulo: "modulo",
        maximum: "max",
        minimum: "min",
        "round up": "ceil",
        "round down": "floor",
        "round closest": "round",
      },
    },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Calculate.defaultProps = { data: defaults };
