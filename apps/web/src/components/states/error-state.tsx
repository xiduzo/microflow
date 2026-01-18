import { OctagonAlertIcon, type LucideIcon } from "lucide-react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import type { PropsWithChildren } from "react";

export function ErrorState(props: Props) {
  const error =
    typeof props.error === "string" ? { message: props.error } : props.error;

  const Icon = props.icon ?? OctagonAlertIcon;

  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-destructive/10">
          <Icon className="text-destructive" />
        </EmptyMedia>
        <EmptyTitle className="text-destructive font-black">
          {props.title ?? "Something went wrong"}
        </EmptyTitle>
        <EmptyDescription>{error?.message ?? "Unknown error"}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{props?.children}</EmptyContent>
    </Empty>
  );
}

type Props = PropsWithChildren & {
  title?: string;
  error: string | { message: string | undefined };
  icon?: LucideIcon;
};
