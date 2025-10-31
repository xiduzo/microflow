import type { ServoData, ServoValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { MODES } from '../../../../common/types';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useDeleteHandles, useNodeControls, useNodeData } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { reducePinsToOptions } from '../../../../common/pin';
import { usePins } from '../../../stores/board';

export function Servo(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			{props.data.type === 'standard' && (
				<>
					<Handle type='target' position={Position.Left} id='min' offset={-1} />
					<Handle type='target' position={Position.Left} id='to' />
					<Handle type='target' position={Position.Left} id='max' offset={1} />
				</>
			)}
			{props.data.type === 'continuous' && (
				<>
					<Handle
						type='target'
						position={Position.Left}
						id='rotate'
						hint='from -1 to 1'
						offset={-0.5}
					/>
					<Handle type='target' position={Position.Left} id='stop' offset={0.5} />
				</>
			)}
			<Handle type='source' position={Position.Right} id='change' />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<ServoData>();
	const value = useNodeValue<ServoValueType>(data.range.min);

	if (data.type === 'continuous') {
		if (!value) return <Icons.Circle className='text-muted-foreground' size={48} />;
		if (value > 0) return <Icons.RotateCw className='animate-spin' size={48} />;
		return <Icons.RotateCcw className='animate-spin direction-reverse' size={48} />;
	}

	return (
		<section className='relative'>
			<section
				className='origin-bottom absolute transition-all'
				style={{ rotate: `${data.range.min - 90}deg` }}
			>
				<Icons.Slash className='-rotate-45 dark:text-red-500/20 text-red-500/30' size={48} />
			</section>
			<section
				className='origin-bottom absolute transition-all'
				style={{ rotate: `${data.range.max - 90}deg` }}
			>
				<Icons.Slash className='-rotate-45 dark:text-green-500/20 text-green-500/30' size={48} />
			</section>
			<section className='origin-bottom transition-all' style={{ rotate: `${value - 90}deg` }}>
				<Icons.Slash className='-rotate-45 text-muted-foreground' size={48} />
			</section>
			<div className='absolute w-4 h-4 left-4 -bottom-2 rounded-full bg-muted-foreground' />
		</section>
	);
}

function Settings() {
	const data = useNodeData<ServoData>();
	const deleteHandles = useDeleteHandles();
	const pins = usePins([MODES.OUTPUT, MODES.PWM]);

	const { render } = useNodeControls(
		{
			pin: { value: data.pin, options: pins.reduce(reducePinsToOptions, {}) },
			type: {
				value: data.type,
				options: ['standard', 'continuous'],
				transient: false,
				onChange: event =>
					deleteHandles(event === 'standard' ? ['rotate', 'stop'] : ['min', 'to', 'max']),
			},
			range: {
				value: data.range,
				step: 1,
				min: 0,
				max: 180,
				render: get => get('type') === 'standard',
			},
		},
		[pins]
	);

	return <>{render()}</>;
}

type Props = BaseNode<ServoData>;
Servo.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['output', 'analog'],
		pin: 3,
		label: 'Servo',
		type: 'standard',
		range: { min: 0, max: 180 },
		description: 'A motor for precise movements or rotation',
	} satisfies Props['data'],
};
