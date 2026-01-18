import { CircleDashedIcon, type LucideIcon } from "lucide-react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import type { PropsWithChildren } from "react";

export function EmptyState(props: Props) {
  const Icon = props.icon ?? CircleDashedIcon;

  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-yellow-500/10">
          <Icon className="text-yellow-500" />
        </EmptyMedia>
        <EmptyTitle className="text-yellow-500 font-black">
          {props.title ?? "Nothing here yet"}
        </EmptyTitle>
        <EmptyDescription>
          {props?.description ?? "Get started by creating something new"}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{props?.children}</EmptyContent>
    </Empty>
  );
}

type Props = PropsWithChildren & {
  title?: string;
  description?: string;
  icon?: LucideIcon;
};
