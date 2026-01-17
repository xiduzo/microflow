import { Icon, type IconName } from "@/components/ui/icon";
import type { AwarenessUser } from "@microflow/collab";

export function PressensePanel(props: Props) {
  return (
    <div className="flex -space-x-3">
      {props.users.map((user) => (
        <div
          key={user.id}
          className="w-8 h-8 rounded-full flex items-center justify-center border-2 border-background"
          style={{ backgroundColor: user.color }}
          title={user.name}
        >
          <Icon icon={user.icon as IconName} size={14} className="text-white" />
        </div>
      ))}
    </div>
  );
}

type Props = {
  users: AwarenessUser[];
};
