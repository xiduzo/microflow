import { Select, SelectContent, SelectItem, SelectTrigger } from '@microflow/ui';
import { MODES, Pin } from '../../common/types';
import { useBoard } from '../providers/BoardProvider';

function pinValue(pin: Pin) {
	return !pin.supportedModes.includes(MODES.ANALOG) ? `${pin.pin}` : `A${pin.analogChannel}`;
}

export function PinSelect<T extends string | number = number>(props: Props<T>) {
	const { pins } = useBoard();

	return (
		<Select
			disabled={!pins.length}
			value={`${props.value}`}
			onValueChange={value => {
				const formattedValue = props.format === 'number' ? Number(value) : value;
				props.onValueChange(formattedValue as T);
			}}
		>
			<SelectTrigger>
				{pins.length > 0 && `Pin ${props.value}`}
				{pins.length === 0 && '-'}
			</SelectTrigger>
			<SelectContent>
				{pins.filter(props.filter ?? (pin => pin)).map(pin => (
					<SelectItem key={pin.pin} value={pinValue(pin)}>
						Pin {pinValue(pin)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

type Props<T extends string | number = number> = {
	value: string | number;
	onValueChange: (value: T) => void;
	format?: T;
	filter?: (value: Pin, index: number, array: Pin[]) => boolean;
};
