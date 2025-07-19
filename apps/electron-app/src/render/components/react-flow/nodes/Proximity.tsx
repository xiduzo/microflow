import { ProximityData, ProximityValueType } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';
import { useNodeValue } from '../../../stores/node-data';
import { usePins } from '../../../stores/board';
import { MODES } from '../../../../common/types';
import { reducePinsToOptions } from '../../../../common/pin';

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
	const data = useNodeData<ProximityData>();
	const pins = usePins([MODES.INPUT, MODES.ANALOG]);

	const { render } = useNodeControls({
		pin: {
			value: data.pin,
			options: pins.reduce(reducePinsToOptions, {}),
		},
		controller: { value: data.controller, options: ['GP2Y0A21YK', 'GP2Y0A710K0F'] }, // MB1000, MB1003, MB1020
		freq: { value: data.freq!, min: 10, label: 'frequency (ms)' },
	});

	return <>{render()}</>;
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
