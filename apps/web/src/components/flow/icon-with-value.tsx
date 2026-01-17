import type { LucideIcon } from "lucide-react";

const formatter = new Intl.NumberFormat();

export function IconWithValue(props: Props) {
  const IconComponent = props.icon;
  return (
    <section className="flex flex-col text-center gap-1 items-center text-muted-foreground">
      <IconComponent size={48} className={props.iconClassName} />
      <div className="text-xs tabular-nums">
        {typeof props.value === "number" ? formatter.format(props.value) : props.value}
        {props.suffix}
      </div>
    </section>
  );
}

type Props = {
  icon: LucideIcon;
  value: string | number;
  suffix?: string;
  iconClassName?: string;
};
