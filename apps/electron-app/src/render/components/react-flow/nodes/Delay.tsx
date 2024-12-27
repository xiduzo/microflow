import { DelayData } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { Handle } from './Handle';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
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
	const { pane, settings } = useNodeSettings<DelayData>();

	useEffect(() => {
		if (!pane) return;

		pane.addBinding(settings, 'delay', {
			index: 0,
			min: 100,
			step: 100,
		});
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<DelayData>;
Delay.defaultProps = {
	data: {
		group: 'flow',
		tags: ['event', 'control'],
		label: 'Delay',
		delay: 1000,
	} satisfies Props['data'],
};
