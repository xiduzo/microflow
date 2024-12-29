import { Icon, IconName } from '@ui/index';

const formatter = new Intl.NumberFormat();

export function IconWithValue(props: Props) {
	return (
		<section className="flex flex-col text-center gap-1 text-muted-foreground">
			<Icon icon={props.icon} size={48} className={props.iconClassName} />
			<div className="text-xs tabular-nums">
				{typeof props.value === 'number' ? formatter.format(props.value) : props.value}
				{props.suffix}
			</div>
		</section>
	);
}

type Props = {
	icon: IconName;
	value: string | number;
	suffix?: string;
	iconClassName?: string;
};
