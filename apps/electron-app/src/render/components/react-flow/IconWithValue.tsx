import { Icon, IconName } from '@ui/index';

const formatter = new Intl.NumberFormat();

export function IconWithValue(props: Props) {
	console.log(props.value, typeof props.value);
	return (
		<section className="flex flex-col text-center gap-1 text-muted-foreground">
			<Icon icon={props.icon} size={48} />
			<div className="text-xs tabular-nums">
				{formatter.format(props.value)}
				{props.suffix}
			</div>
		</section>
	);
}

type Props = {
	icon: IconName;
	value: number;
	suffix?: string;
};
