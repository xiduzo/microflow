import { cva } from "@fhb/ui";
import { PropsWithChildren } from "react";
import { IconBackButton } from "./IconBackButton";

export function PageHeader(props: PageHeaderProps) {
  return (
    <header className="flex p-2 items-center h-12">
      <IconBackButton />
      {props.start}
      <h1 className="flex-1">{props.title}</h1>
      {props.end}
    </header>
  );
}

type PageHeaderProps = {
  start?: JSX.Element;
  title: string;
  end?: JSX.Element;
};

export function PageContent(props: PropsWithChildren & { className?: string }) {
  return (
    <main className={pageContent({ className: props.className })}>{props.children}</main>
  );
}

const pageContent = cva("flex flex-col space-y-3 p-4 w-full")
