import { NodeContainer, useNodeControls, useNodeData, type BaseNode } from "../_base/_base";
import { defaults, type Data } from "./note.schema";

export function Note(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();

  return (
    <section className="text-wrap w-64 text-center flex flex-col p-2 gap-1">
      <span>{data.note}</span>
      <span className="text-xs text-muted-foreground">{data.extraInfo}</span>
    </section>
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const { render } = useNodeControls({
    note: { value: data.note, label: "Note", rows: 3 },
    extraInfo: { value: data.extraInfo, label: "Extra info", rows: 3 },
  });

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Note.defaultProps = { data: defaults };
