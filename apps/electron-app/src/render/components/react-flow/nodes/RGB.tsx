import { RgbData, RgbValueType } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeSettings } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';
import { usePins } from '../../../stores/board';
import { useEffect } from 'react';
import { MODES } from '../../../../common/types';
import { mapPinToPaneOption } from '../../../../utils/pin';
import { useNodeValue } from '../../../stores/node-data';
import { RgbaColorPicker } from 'react-colorful';

export function Rgb(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="red" hint="0-255" offset={-1.5} />
			<Handle type="target" position={Position.Left} id="green" hint="0-255" offset={-0.5} />
			<Handle type="target" position={Position.Left} id="blue" hint="0-255" offset={0.5} />
			<Handle type="target" position={Position.Left} id="alpha" hint="0-100" offset={1.5} />
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<RgbValueType>({ r: 0, g: 0, b: 0, a: 1 });

	return <RgbaColorPicker color={value} />;
}

function Settings() {
	const { pane, settings } = useNodeSettings<RgbData>();
	const pins = usePins();

	useEffect(() => {
		if (!pane) return;

		const colors = ['red', 'green', 'blue'];

		const colorBindings = colors.map((color, index) => {
			return pane.addBinding(settings.pins, color, {
				view: 'list',
				disabled: !pins.length,
				label: color,
				index: index,
				options: pins
					.filter(
						pin =>
							pin.supportedModes.includes(MODES.OUTPUT) && pin.supportedModes.includes(MODES.PWM),
					)
					.map(mapPinToPaneOption),
			});
		});

		const isAnodeBinding = pane.addBinding(settings, 'isAnode', {
			view: 'toggle',
			label: 'anode',
			index: 3,
		});

		return () => {
			[...colorBindings, isAnodeBinding].forEach(disposable => disposable.dispose());
		};
	}, [pane, settings, pins]);

	return null;
}

type Props = BaseNode<RgbData>;
Rgb.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['output', 'analog'],
		label: 'RGB',
		pins: {
			red: 9,
			green: 10,
			blue: 11,
		},
		isAnode: false,
		description: 'Control an RGB LED',
	} satisfies Props['data'],
};
