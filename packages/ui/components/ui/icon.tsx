import * as Icons from 'lucide-react';
import { AArrowDown } from 'lucide-react';

export function Icon(props: Props) {
	const Component = Icons[props.icon] as typeof AArrowDown;

	return <Component size={14} {...props} />;
}

export type IconName = keyof typeof Icons;

type Props = Icons.LucideProps & {
	icon: IconName;
};
