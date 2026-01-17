import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { CollabUser } from "../collab-cursors";
import { Icon } from "@/components/ui/icon";

export function PressensePanel(props: Props) {
  console.log(props.users);
  return (
    <div className="flex -space-x-3">
      {props.users.map((user) => (
        <Avatar
          key={user.id}
          style={{
            background: user.color,
          }}
        >
          <AvatarFallback
            style={{
              background: user.color,
            }}
          >
            <Icon icon="Link2OffIcon" size={12} className="invert" />
          </AvatarFallback>
        </Avatar>
      ))}
    </div>
  );
}

type Props = {
  users: CollabUser[];
};
