import type { AwarenessUser } from "@microflow/collab";
import { useReactFlow } from "@xyflow/react";
import { MousePointer2Icon } from "lucide-react";
import { Icon, type IconName } from "../ui/icon";

type CollabCursorsProps = {
  users: AwarenessUser[];
};

/**
 * Renders cursors of other users on the canvas
 */
export function CollabCursors({ users }: CollabCursorsProps) {
  const { flowToScreenPosition } = useReactFlow();

  return (
    <div
      className="absolute inset-0 pointer-events-none z-10"
      style={{ clipPath: "inset(0)" }}
    >
      {users.map((user) => {
        if (!user.cursor) return null;

        const screenPos = flowToScreenPosition(user.cursor);

        return <Cursor key={user.id} {...user} cursor={screenPos} />;
      })}
    </div>
  );
}

export function Cursor(props: AwarenessUser) {
  return (
    <div
      className="fixed transition-all duration-[10]"
      style={{
        left: props.cursor?.x,
        top: props.cursor?.y,
        transform: "translate(-2px, -2px)",
      }}
    >
      <MousePointer2Icon style={{ stroke: props.color, fill: props.color }} />
      {/* User name label */}
      <section className="absolute left-4.5 top-4.5 flex items-center gap-2">
        <div
          style={{ backgroundColor: props.color }}
          className="px-2 py-0.5 rounded"
        >
          {props.name}
        </div>
      </section>
    </div>
  );
}

type CursorProps = {
  color: string;
  name: string;
  offset: { x: number; y: number };
};
