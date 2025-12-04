import { type Data, type Value, dataSchema } from '@microflow/runtime/src/delay/delay.types';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';
import { IconWithValue } from '../IconWithValue';

export function Delay(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='signal' />
			<Handle type='source' position={Position.Right} id='bang' />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<Data>();

	return (
		<IconWithValue
			icon='Snail'
			value={`${data.forgetPrevious ? 'debounced ' : ''}${data.delay / 1000}`}
			suffix='s'
		/>
	);
}

function Settings() {
	const data = useNodeData<Data>();
	const { render } = useNodeControls({
		delay: {
			min: 100,
			step: 100,
			value: data.delay,
			label: 'delay (ms)',
		},
		forgetPrevious: {
			value: data.forgetPrevious,
			label: 'debounce',
		},
	});

	return <>{render()}</>;
}

type Props = BaseNode<Data>;
Delay.defaultProps = {
	data: {
		...dataSchema.parse({}),
		group: 'flow',
		tags: ['control', 'event'],
		label: 'Delay',
		icon: 'SnailIcon',
		description: 'Wait for a specified amount of time before sending a signal forward',
	} satisfies Props['data'],
};
