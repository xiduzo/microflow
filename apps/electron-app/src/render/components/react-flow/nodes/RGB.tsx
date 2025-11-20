import { RgbData, RgbValueType } from '@microflow/hardware';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';
import { usePins } from '../../../stores/board';
import { MODES } from '../../../../common/types';
import { reducePinsToOptions } from '../../../../common/pin';
import { useNodeValue } from '../../../stores/node-data';
import { RgbaColorPicker } from 'react-colorful';

export function Rgb(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='red' hint='0-255' offset={-1.5} />
			<Handle type='target' position={Position.Left} id='green' hint='0-255' offset={-0.5} />
			<Handle type='target' position={Position.Left} id='blue' hint='0-255' offset={0.5} />
			<Handle type='target' position={Position.Left} id='alpha' hint='0-100' offset={1.5} />
			<Handle type='source' position={Position.Right} id='change' />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<RgbValueType>({ r: 0, g: 0, b: 0, a: 1 });

	return (
		<section className='px-10'>
			<RgbaColorPicker color={value} />
		</section>
	);
}

function Settings() {
	const pins = usePins([MODES.OUTPUT, MODES.PWM]);
	const data = useNodeData<RgbData>();
	const { render } = useNodeControls({
		red: {
			value: Array.isArray(data.pins) ? data.pins[0] : data.pins.red,
			options: pins.reduce(reducePinsToOptions, {}),
		},
		green: {
			value: Array.isArray(data.pins) ? data.pins[1] : data.pins.green,
			options: pins.reduce(reducePinsToOptions, {}),
		},
		blue: {
			value: Array.isArray(data.pins) ? data.pins[2] : data.pins.blue,
			options: pins.reduce(reducePinsToOptions, {}),
		},
		isAnode: { value: Boolean(data.isAnode), label: 'anode' },
	});

	return <>{render()}</>;
}

type Props = BaseNode<RgbData>;
Rgb.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['output', 'analog'],
		label: 'RGB',
		icon: 'PaletteIcon',
		pins: {
			red: 9,
			green: 10,
			blue: 11,
		},
		isAnode: false,
		description:
			'Control a colored light that can display any color by mixing red, green, and blue',
	} satisfies Props['data'],
};
