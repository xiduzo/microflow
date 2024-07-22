import {
  Icons,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
} from "@fhb/ui";
import { Position } from "@xyflow/react";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useUpdateNodeData } from "../../../hooks/nodeUpdater";
import { nodeSelector, useNodesEdgesStore } from "../../../store";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

// TODO: add custom method validator
const validators = ["boolean", "number", "text"] as const;
const subValidators = {
  boolean: [],
  number: [
    "equal to",
    "greater than",
    "less than",
    "between",
    "outside",
    "is even",
    "is odd",
  ],
  text: ["equal to", "includes", "starts with", "ends with"], // TODO regex
};
type Validator = (typeof validators)[number];

const MAX_NUMERIC_VALUE = 1023;

export function IfElse(props: Props) {
  const { node } = useNodesEdgesStore(
    useShallow(nodeSelector<Props["data"]>(props.id)),
  );

  const { updateNodeData } = useUpdateNodeData<IfElseData>(props.id);


  useEffect(() => {
    if (!node?.data) return;

    if (node.data.validator === "number") {
      const isRange = ["between", "outside"].includes(node.data.subValidator);
      const currentValue = Number(node.data.validatorArgs[0] ?? 0);
      const validatorArgs = [currentValue];
      if (isRange) {
        const increment = (MAX_NUMERIC_VALUE + 1) * 0.25;
        const nextValueBackup =
          currentValue + increment >= MAX_NUMERIC_VALUE
            ? currentValue - increment
            : currentValue + increment;
        const nextValue = Number(
          node.data.validatorArgs[1] ?? nextValueBackup,
        );
        if (nextValue > currentValue) {
          validatorArgs.push(nextValue);
        } else {
          validatorArgs.unshift(nextValue);
        }
      }

      if (node.data.validatorArgs.length === validatorArgs.length) {
        return;
      }

      updateNodeData({ validatorArgs });
    }
  }, [node?.data.validator, node?.data.subValidator, node?.data.validatorArgs]);

  if (!node) return null;

  return (
    <NodeContainer {...props}>
      <NodeContent>
        <NodeHeader>
          {node.data.value === true && (
            <Icons.Check className="w-12 h-12 text-green-500" />
          )}
          {node.data.value === false && (
            <Icons.X className="w-12 h-12 text-red-500" />
          )}
          {node.data.value === null ||
            (node.data.value === undefined && (
              <Icons.Dot className="w-12 h-12 text-gray-500" />
            ))}
        </NodeHeader>
        <Select
          value={node.data.validator}
          onValueChange={(value) =>
            updateNodeData({
              validator: value as Validator,
              subValidator: subValidators[value][0],
            })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="Validator" />
          </SelectTrigger>
          <SelectContent>
            {validators.map((validator) => (
              <SelectItem key={validator} value={validator}>
                {validator}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {subValidators[node.data.validator]?.length > 0 && (
          <Select
            disabled={!node.data.validator}
            value={node.data.subValidator}
            onValueChange={(value) =>
              updateNodeData({
                validator: node.data.validator,
                subValidator: value,
              })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Validate with" />
            </SelectTrigger>
            <SelectContent>
              {subValidators[node.data.validator]?.map((subvalidator) => (
                <SelectItem key={subvalidator} value={subvalidator}>
                  {subvalidator}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {node.data.validator === "text" && (
          <Input
            value={(node.data.validatorArgs[0] as string) ?? ""}
            type="text"
            placeholder="Expected value"
            onChange={(e) =>
              updateNodeData({ validatorArgs: [e.target.value] })
            }
          />
        )}
        {node.data.validator === "number" &&
          !["is even", "is odd"].includes(node.data.subValidator) && (
            <>
              <Label
                htmlFor={`slider-numeric-${node.id}`}
                className="flex justify-between"
              >
                {node.data.validatorArgs?.map((value, index) => (
                  <span key={index} className="opacity-40 font-light">
                    {String(value)}
                  </span>
                ))}
              </Label>
              <Slider
                id={`slider-if-else-${node.id}`}
                key={node.data.validatorArgs.length ?? 0}
                defaultValue={
                  (node.data.validatorArgs.filter(
                    (arg) => arg !== undefined,
                  ) as number[]) ?? [0]
                }
                min={0}
                max={MAX_NUMERIC_VALUE}
                step={1}
                onValueChange={(values) =>
                  updateNodeData({ validatorArgs: values })
                }
              />
            </>
          )}
      </NodeContent>
      <Handle type="target" position={Position.Top} id="check" />
      <Handle type="source" position={Position.Right} id="change" />
      <Handle
        type="source"
        position={Position.Bottom}
        id="true"
        offset={-0.5}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="false"
        offset={0.5}
      />
    </NodeContainer>
  );
}

export type IfElseData = {
  validatorArgs: unknown[];
  validator: Validator;
  subValidator: string;
};
type Props = AnimatedNode<IfElseData, boolean>;
