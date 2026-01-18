import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Card, CardContent } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { cloneElement, isValidElement } from "react";
import type { PropsWithChildren } from "react";

export function LoadingState(props: Props) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-blue-500/10">
          <LoaderCircleIcon className="animate-spin text-blue-500" />
        </EmptyMedia>
        <EmptyTitle className="font-black">
          {props.title ?? "Loading..."}
        </EmptyTitle>
        <EmptyDescription>
          {props?.description ?? "This should not take long"}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{props?.children}</EmptyContent>
    </Empty>
  );
}

type Props = PropsWithChildren & {
  title?: string;
  description?: string;
};

export function LoadingStateSkeleton(props: LoadingStateSkeletonProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {Array.from({ length: props.count ?? 3 }).map((_, i) =>
        isValidElement(props.skeleton) ? (
          cloneElement(props.skeleton, { key: i })
        ) : (
          <DefaultLoadingStateSkeleton key={i} />
        )
      )}
    </div>
  );
}

function DefaultLoadingStateSkeleton() {
  return (
    <Card>
      <CardContent>
        <Skeleton className="aspect-4/3 rounded-none" />
      </CardContent>
    </Card>
  );
}

type LoadingStateSkeletonProps = {
  count?: number;
  skeleton?: React.ReactNode;
};
