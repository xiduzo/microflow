import { Icon, type IconName } from "@/components/ui/icon";
import type { AwarenessUser } from "@microflow/collab";
import { Heart } from "lucide-react";

export function PressensePanel(props: Props) {
  return (
    <div className="flex -space-x-3">
      {props.users.map((user) => (
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
}

type Props = {
  users: AwarenessUser[];
};
