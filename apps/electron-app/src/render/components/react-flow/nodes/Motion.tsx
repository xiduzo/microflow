import type { MotionData, MotionValueType } from '@microflow/components';
import { MOTION_CONTROLLERS } from '@microflow/components/contants';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { MODES } from '../../../../common/types';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, NodeSettings, useNodeData } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { mapPinsToSettings } from '../../../../utils/pin';
import { usePins } from '../../../stores/board';

export function Motion(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle
				type="source"
				position={Position.Right}
				id="motionstart"
				title="Started motion"
				offset={-1}
			/>
			<Handle type="source" position={Position.Right} id="change" />
			<Handle
				type="source"
				position={Position.Right}
				id="motionend"
				title="Ended motion"
				offset={1}
			/>
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<MotionValueType>(false);

	if (!value) return <Icons.EyeClosed className="text-muted-foreground" size={48} />;
	return <Icons.Eye className="text-green-500" size={48} />;
}

function Settings() {
	const data = useNodeData<MotionData>();
	const pins = usePins([MODES.INPUT]);

	return (
		<NodeSettings
			settings={{
				// TODO: filter pins dynamically
				// const isCorrectMode =
				// 	pin.supportedModes.includes(MODES.INPUT) && !pin.supportedModes.includes(MODES.I2C);

				// if (settings.controller === 'HCSR501') {
				// 	return isCorrectMode && !pin.supportedModes.includes(MODES.ANALOG);
				// } else {
				// 	return isCorrectMode && pin.supportedModes.includes(MODES.ANALOG);
				// }
				pin: {
					value: data.pin,
					options: pins.reduce(mapPinsToSettings, {}),
				},
				controller: { value: data.controller, options: MOTION_CONTROLLERS },
			}}
		/>
	);
}

type Props = BaseNode<MotionData>;
Motion.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['input', 'digital'],
		pin: '8',
		label: 'Motion',
		controller: 'HCSR501',
		description: 'Detect and respond to (the absense of) motion',
	} satisfies Props['data'],
};
