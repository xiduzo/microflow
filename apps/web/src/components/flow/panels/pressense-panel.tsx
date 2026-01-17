import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { CollabUser } from "../collab-cursors";

export function PressensePanel(props: Props) {
  return (
    <div className="*:data-[slot=avatar]:ring-background flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:grayscale">
      {props.users.map((user) => (
        <Avatar>
          <AvatarImage src="https://github.com/maxleiter.png" alt="@maxleiter" />
          <AvatarFallback>LR</AvatarFallback>
        </Avatar>
      ))}
    </div>
  );
}

type Props = {
  users: CollabUser[];
};
