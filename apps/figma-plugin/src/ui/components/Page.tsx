import { PropsWithChildren } from "react";
import { IconBackButton } from "./IconBackButton";

export function PageHeader(props: PageHeaderProps) {
  return (
    <header className="flex p-2">
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
    <main className={"px-2 w-full " + props.className}>{props.children}</main>
  );
}
