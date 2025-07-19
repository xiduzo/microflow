import type { MotionData, MotionValueType } from '@microflow/components';
import { MOTION_CONTROLLERS } from '@microflow/components/contants';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { MODES } from '../../../../common/types';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { reducePinsToOptions } from '../../../../common/pin';
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
	const pins = usePins(
		data.controller === 'HCSR501' ? [MODES.INPUT] : [MODES.INPUT, MODES.ANALOG],
		data.controller === 'HCSR501' ? [MODES.I2C, MODES.ANALOG] : [MODES.I2C],
	);
	const { render } = useNodeControls(
		{
			pin: { value: data.pin, options: pins.reduce(reducePinsToOptions, {}) },
			controller: { value: data.controller, options: MOTION_CONTROLLERS },
		},
		[pins],
	);

	return <>{render()}</>;
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
