import { Badge } from "@/components/ui/badge";
import { useDragAndDrop } from "@/providers/drag-and-drop";
import type { PropsWithChildren } from "react";

export function DndBadge(props: Props) {
  const { dragging, setDragging, setHover } = useDragAndDrop();

  return (
    <Badge
      style={{ opacity: dragging === props.id ? 0.25 : 1 }}
      draggable
      onDragStart={setDragging(props.id)}
      onDragEnd={setDragging("")}
      onDragExit={setDragging("")}
      onDragEnter={setHover(props.id)}
      onDragLeave={setHover("")}
      onDrop={() => {
        setDragging("");
        setHover("");
      }}
      className="flex justify-between hover:cursor-grab"
      variant="secondary"
    >
      {props.children}
    </Badge>
  );
}

type Props = PropsWithChildren & { id: string };
