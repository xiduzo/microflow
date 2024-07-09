import { PropsWithChildren } from "react";

export function Node(props: Props) {
  return (
    <div className="bg-secondary border border-zinc-700 rounded-md p-2 hover:cursor-grab active:cursor-grabbing has-[.selected]:border-zinc-400">
      {props.children}
    </div>
  );
}

type Props = PropsWithChildren;
