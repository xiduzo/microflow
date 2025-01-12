import { ProximityData, ProximityValueType } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeSettings } from './Node';
import { Handle } from './Handle';
import { Position } from '@xyflow/react';
import { useNodeValue } from '../../../stores/node-data';
import { usePins } from '../../../stores/board';
import { useEffect } from 'react';
import { MODES } from '../../../../common/types';
import { mapPinToPaneOption } from '../../../../utils/pin';

export function Proximity(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<ProximityValueType>(0);

	return <div>{value}</div>;
}

function Settings() {
	const { pane, settings } = useNodeSettings<ProximityData>();
	const pins = usePins();

	useEffect(() => {
		if (!pane) return;

		const pinBinding = pane.addBinding(settings, 'pin', {
			view: 'list',
			disabled: !pins.length,
			index: 0,
			options: pins
				.filter(
					pin =>
						pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.ANALOG),
				)
				.map(mapPinToPaneOption),
		});

		const constrollerBinding = pane.addBinding(settings, 'controller', {
			view: 'list',
			index: 1,
			options: [
				{ value: 'GP2Y0A21YK', text: 'GP2Y0A21YK' },
				{ value: 'GP2Y0A710K0F', text: 'GP2Y0A710K0F' },
				// { value: "MB1000", text: "MB1000 (untested)"},
				// { value: "MB1003", text: "MB1003 (untested)"},
				// { value: "MB1230", text: "MB1230 (untested)"},
			],
		});

		const freqBinding = pane.addBinding(settings, 'freq', {
			index: 2,
			label: 'frequency (ms)',
			min: 10,
		});

		return () => {
			pinBinding.dispose();
			constrollerBinding.dispose();
			freqBinding.dispose();
		};
	}, [pane, settings, pins]);

	return null;
}

type Props = BaseNode<ProximityData>;
Proximity.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['input', 'analog'],
		freq: 25,
		pin: 'A0',
		controller: 'GP2Y0A21YK',
		label: 'Proximity',
		description: 'Detect and measure distance to an object',
	} satisfies Props['data'],
};

// GP2Y0A21YK, GP2D120XJ00F, GP2Y0A02YK0F, GP2Y0A41SK0F, GP2Y0A710K0F, PING_PULSEIN *, MB1000, MB1003, MB1230, LIDARLITE. See aliases
