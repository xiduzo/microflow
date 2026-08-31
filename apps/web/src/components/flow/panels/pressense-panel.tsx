import { Icon, type IconName } from "@/components/ui/icon";
import { Heart } from "lucide-react";
import { memo } from "react";
import { useCollabPresence } from "@/session";

/**
 * The collaborator avatars. Subscribes to presence directly — see the note in
 * `CollabCursors` — so a remote cursor move does not travel through the canvas
 * to reach it.
 */
export const PressensePanel = memo(function PressensePanel() {
  const { otherUsers: users } = useCollabPresence();

  return (
    <div className="flex -space-x-3">
      {users.map((user) => (
        <div key={user.id} className="relative">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center border-2 border-background"
            style={{ backgroundColor: user.color }}
            title={user.name}
          >
            <Icon
              icon={user.icon as IconName}
              size={14}
              className="text-white"
            />
          </div>
          {user.isSupporter ? (
            <Heart
              className="absolute top-0.5 left-0.5 size-2! dark:fill-rose-200 fill-rose-600"
              aria-label="Supporter"
            />
          ) : null}
        </div>
      ))}
    </div>
  );
});
