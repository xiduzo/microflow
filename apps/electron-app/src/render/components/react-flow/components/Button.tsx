import {
  Badge,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuSeparator,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Separator,
  Slider,
  Button as UiButton,
} from "@fhb/ui";
import { Position, useReactFlow } from "@xyflow/react";
import { ButtonOption } from "johnny-five";
import { useShallow } from "zustand/react/shallow";
import { MODES } from "../../../../common/types";
import { useCodeUploader } from "../../../hooks/codeUploader";
import { useBoard } from "../../../providers/BoardProvider";
import { nodeSelector, useNodesEdgesStore } from "../../../store";
import { Handle } from "./Handle";
import { AnimatedNode, NodeContainer, NodeContent, NodeHeader } from "./Node";

export function Button(props: Props) {
  const { node } = useNodesEdgesStore(
    useShallow(nodeSelector<Props["data"]>(props.id)),
  );
  const uploadCode = useCodeUploader();

  const { checkResult } = useBoard();

  const { updateNodeData } = useReactFlow();

  function handleNodeUpdate(data: Partial<Props["data"]>) {
    updateNodeData(props.id, data);
    uploadCode();
  }

  if (!node) return null;

  const hasMetadata =
    node.data.invert || node.data.isPullup || node.data.isPulldown;

  return (
    <NodeContainer
      {...props}
      contextMenu={
        <ContextMenuContent>
          <ContextMenuCheckboxItem
            checked={node.data.invert}
            onClick={() => handleNodeUpdate({ invert: !node.data.invert })}
          >
            Invert
          </ContextMenuCheckboxItem>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem
            checked={node.data.isPullup}
            onClick={() =>
              handleNodeUpdate({
                isPullup: !node.data.isPullup,
                isPulldown: false,
              })
            }
          >
            Initialize as a pullup button
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={node.data.isPulldown}
            onClick={() =>
              handleNodeUpdate({
                isPulldown: !node.data.isPulldown,
                isPullup: false,
              })
            }
          >
            Initialize as a pulldown button
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      }
    >
      <NodeContent>
        <NodeHeader>
          <UiButton disabled variant={props.data.value ? "default" : "outline"}>
            {props.id}
          </UiButton>
        </NodeHeader>
        <Select
          value={node.data.pin.toString()}
          onValueChange={(value) => handleNodeUpdate({ pin: parseInt(value) })}
        >
          <SelectTrigger>Pin {node.data.pin}</SelectTrigger>
          <SelectContent>
            {checkResult.pins
              ?.filter((pin) => pin.supportedModes.includes(MODES.INPUT))
              .map((pin) => (
                <SelectItem key={pin.pin} value={pin.pin.toString()}>
                  Pin {pin.pin}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Label
          htmlFor={`holdtime-${props.id}`}
          className="flex justify-between"
        >
          Hold time
          <span className="opacity-40 font-light">
            {node.data.holdtime ?? 500} ms
          </span>
        </Label>
        <Slider
          id={`holdtime-${props.id}`}
          className="pb-2"
          defaultValue={[node.data.holdtime ?? 500]}
          min={500}
          max={2500}
          step={50}
          onValueChange={(value) =>
            updateNodeData(props.id, { holdtime: value[0] })
          }
        />
        {hasMetadata && <Separator className="my-3" />}
        {hasMetadata && (
          <section className="flex space-x-2">
            {node.data.invert && <Badge>Inverted</Badge>}
            {node.data.isPullup && <Badge>Pull up</Badge>}
            {node.data.isPulldown && <Badge>Pull down</Badge>}
          </section>
        )}
      </NodeContent>
      <Handle type="source" position={Position.Bottom} id="down" index={-1} />
      <Handle type="source" position={Position.Bottom} id="hold" />
      <Handle type="source" position={Position.Bottom} id="up" index={1} />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

export type ButtonData = Omit<ButtonOption, "board">;
type Props = AnimatedNode<ButtonData, boolean>;
