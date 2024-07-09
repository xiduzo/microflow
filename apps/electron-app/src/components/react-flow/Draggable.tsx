import { DragEvent, PropsWithChildren } from "react";

export function Draggable(props: Props) {
  const onDragStart = (event: DragEvent, nodeType: string) => {
    event.dataTransfer.setData("application/reactflow", nodeType);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <section
      className="hover:cursor-grab active:cursor-grabbing"
      draggable
      onDragStart={(event) => onDragStart(event, props.type)}
    >
      {props.children}
    </section>
  );
}

type Props = PropsWithChildren & {
  type: string;
};
