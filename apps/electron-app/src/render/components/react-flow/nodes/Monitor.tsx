import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import type { DebugValueType, MonitorData } from '@microflow/components';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect, useRef } from 'react';
import { LevaPanel, monitor, useControls, useCreateStore } from 'leva';

export function Monitor(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="debug" />
		</NodeContainer>
	);
}
function Value() {
	const data = useNodeData<MonitorData>();
	const store = useCreateStore();
	const value = useNodeValue<DebugValueType>(data.type === 'graph' ? 0 : '');

	const ref = useRef(value);

	useControls(
		{
			' ': monitor(ref, { graph: data.type === 'graph', interval: data.interval }),
		},
		{ store },
		[data.type, data.interval],
	);
	useEffect(() => {
		ref.current = value;
	}, [value]);

	return <LevaPanel store={store} fill={true} flat titleBar={false} />;
}

function Settings() {
	const data = useNodeData<MonitorData>();
	const { render } = useNodeControls({
		type: { value: data.type, options: ['graph', 'raw'] },
		interval: { value: data.interval, min: 16.6, label: 'interval (ms)' },
	});

	return <>{render()}</>;
}

type Props = BaseNode<MonitorData>;
Monitor.defaultProps = {
	data: {
		group: 'flow',
		tags: ['output', 'information'],
		label: 'Monitor',
		type: 'graph',
		interval: 1000 / 60,
		description: 'Debug and visualize signals',
	} satisfies Props['data'],
};
