import { Badge } from "@fhb/ui";
import { DragEvent } from "react";

export function Draggable(props: Props) {
  const onDragStart = (event: DragEvent, nodeType: string) => {
    event.dataTransfer.setData("application/reactflow", nodeType);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <article
      className="hover:cursor-grab active:cursor-grabbing p-4 border rounded-md"
      draggable
      onDragStart={(event) => onDragStart(event, props.type)}
    >
      <section className="flex space-x-2 items-center">
        {props.icon}
        <h1 className="font-bold text-lg">{props.title}</h1>
      </section>
      <p className="font-light mt-2">{props.description}</p>
      {props.tags?.length && (
        <section className="mt-3 flex space-x-2 text-xs">
          {props.tags.map((tag) => (
            <Badge variant="secondary" key={tag}>
              {tag}
            </Badge>
          ))}
        </section>
      )}
    </article>
  );
}

type Props = {
  type: string;
  title: string;
  description: string;
  icon: JSX.Element;
  tags?: string[];
};
