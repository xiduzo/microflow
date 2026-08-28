import type { AwarenessUser } from "@microflow/collab";
import { useReactFlow } from "@xyflow/react";
import { Heart, MousePointer2Icon } from "lucide-react";
import { memo } from "react";
import { useCollabPresence } from "@/session";

/**
 * Renders cursors of other users on the canvas.
 *
 * Subscribes to presence itself rather than taking it as a prop. Remote
 * cursors move at pointer rate, and every one of those events used to travel
 * through the canvas component — re-rendering the whole editor subtree to move
 * an arrow a few pixels. Keeping the subscription here confines that churn to
 * the layer that actually draws it.
 */
export const CollabCursors = memo(function CollabCursors() {
  const { otherUsers: users } = useCollabPresence();
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
});

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
      <div className="relative">
        <MousePointer2Icon style={{ stroke: props.color, fill: props.color }} />
      </div>
      {/* User name label */}
      <section className="absolute left-4.5 top-4.5 flex items-center gap-2">
        <div
          style={{ backgroundColor: props.color }}
          className="px-2 py-0.5 rounded text-white flex items-center gap-1"
        >
          {props.name}
          {props.isSupporter ? (
            <Heart
              className="size-3 text-rose-200 dark:fill-rose-200 fill-rose-600 -top-1 -right-1 absolute"
              aria-label="Supporter"
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
