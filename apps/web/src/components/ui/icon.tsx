import * as Icons from "lucide-react";
import { BadgeQuestionMarkIcon } from "lucide-react";

export function Icon(props: Props) {
  const Component = Icons[props.icon] as typeof BadgeQuestionMarkIcon;

  if (!Component) {
    console.warn(`Icon "${props.icon}" not found in lucide-react`);
    return <BadgeQuestionMarkIcon size={14} {...props} />;
  }

  return <Component size={14} {...props} />;
}

export type IconName = keyof typeof Icons;

type Props = Icons.LucideProps & {
  icon: IconName;
};
