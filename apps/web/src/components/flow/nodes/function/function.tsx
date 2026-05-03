import { dataSchema, defaults, type Data, type Value } from "./function.schema";
import { Handle } from "../../handle";
import {
  NodeContainer,
  useDeleteHandles,
  useNodeControls,
  useNodeData,
  useNodeId,
  type BaseNode,
} from "../_base/_base";
import { BracesIcon } from "lucide-react";
import { button } from "leva";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useUpdateNodeInternals } from "@xyflow/react";
import { useNodeValue } from "@/stores/node-data";
import { IconWithValue } from "../../icon-with-value";

const FunctionCodeEditor = lazy(() =>
  import("./function-code-editor").then((m) => ({ default: m.FunctionCodeEditor })),
);

export function Function(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle type="target" position="left" id="trigger" handleType="command" />
      <Handle type="source" position="right" id="value" handleType="value" />
      <DynamicHandles />
    </NodeContainer>
  );
}

/** Strip single-line (//) and multi-line comments before extracting template vars. */
function extractTemplateVars(code: string): string[] {
  const stripped = code
    .replace(/\/\/.*$/gm, "")   // remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, ""); // remove multi-line comments
  const matches = stripped.match(/\{\{(\w+)\}\}/g) ?? [];
  return Array.from(
    new Set(matches.map((m) => m.replace(/\{|\}/g, ""))),
  ).filter(Boolean);
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>("")
  const preview = data.code.split("\n")[0]?.trim().slice(0, 24) ?? "";

  return <IconWithValue icon={BracesIcon} value={JSON.stringify(value)} />;
}

function Settings() {
  const data = useNodeData<Data>();
  const [editorOpened, setEditorOpened] = useState(false);

  const dynamicVars = useMemo(() => {
    return extractTemplateVars(data.code ?? "");
  }, [data.code]);

  const { render, setNodeData } = useNodeControls(
    {
      "edit code": button(() => setEditorOpened(true)),
    },
    [],
  );

  return (
    <>
      {render()}
      {editorOpened && (
        <Suspense>
          <FunctionCodeEditor
            code={data.code}
            dynamicVars={dynamicVars}
            onSave={(code) => {
              setNodeData({ ...data, code });
              setEditorOpened(false);
            }}
            onClose={() => setEditorOpened(false)}
          />
        </Suspense>
      )}
    </>
  );
}

function DynamicHandles() {
  const data = useNodeData<Data>();
  const id = useNodeId();
  const previousHandles = useRef<string[]>([]);
  const deleteHandles = useDeleteHandles();
  const update = useUpdateNodeInternals();

  const handles = useMemo(() => {
    return extractTemplateVars(data.code ?? "");
  }, [data.code]);

  useEffect(() => {
    const difference = handles.filter((h) => !previousHandles.current.includes(h));
    if (previousHandles.current.length) deleteHandles(difference);
    previousHandles.current = handles;
    update(id);
  }, [handles, id, update, deleteHandles]);

  return (
    <>
      {handles.slice(0, 7).map((handle, index) => (
        <Handle
          key={handle}
          type="target"
          position="bottom"
          id={handle}
          handleType="value"
          offset={index - (handles.length - 1) / 2}
        />
      ))}
    </>
  );
}

type Props = BaseNode<Data>;
Function.defaultProps = { data: defaults };
