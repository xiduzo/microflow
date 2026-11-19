import { dataSchema, defaults, type Data, type Value } from "./function.schema";
import { templateVariables } from "./function.handles";
import { NodeHandles } from "../_base/node-handles";
import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { BracesIcon } from "lucide-react";
import { button } from "leva";
import { lazy, Suspense, useMemo, useState } from "react";
import { useNodeValue } from "@/nodes/live/node-data";
import { IconWithValue } from "../_base/icon-with-value";

const FunctionCodeEditor = lazy(() =>
  import("./function-code-editor").then((m) => ({ default: m.FunctionCodeEditor })),
);

export function Function(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <NodeHandles />
    </NodeContainer>
  );
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
    return templateVariables(data.code ?? "");
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

type Props = BaseNode<Data>;
Function.defaultProps = { data: defaults };
