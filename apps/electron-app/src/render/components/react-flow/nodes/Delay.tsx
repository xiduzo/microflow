import { DelayData } from '@microflow/components';
import { BaseNode, NodeContainer, NodeSettings, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';
import { IconWithValue } from '../IconWithValue';

export function Delay(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="signal" />
			<Handle type="source" position={Position.Right} id="bang" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<DelayData>();

	return <IconWithValue icon="Snail" value={data.delay / 1000} suffix="s" />;
}

function Settings() {
	const data = useNodeData<DelayData>();

	return (
		<NodeSettings
			settings={{
				delay: { min: 100, step: 100, value: data.delay, label: 'delay (ms)' },
				forgetPrevious: { value: data.forgetPrevious, label: 'debounce' },
			}}
		/>
	);
}

type Props = BaseNode<DelayData>;
Delay.defaultProps = {
	data: {
		group: 'flow',
		tags: ['event', 'control'],
		label: 'Delay',
		delay: 1000,
		forgetPrevious: false,
		description: 'Introduce a delay before passing on the signal',
	} satisfies Props['data'],
};
