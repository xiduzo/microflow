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
			' ': monitor(ref, { graph: data.type === 'graph', interval: 1000 / data.fps }),
		},
		{ store },
		[data.type, data.fps],
	);
	useEffect(() => {
		ref.current = value;
	}, [value]);

	if (data.type === 'raw')
		return (
			<div className="text-xs text-gray-500 text-start grow p-4">
				{typeof value === 'string' ? value : <pre>{JSON.stringify(value, null, 2)}</pre>}
			</div>
		);
	return <LevaPanel store={store} fill={true} flat titleBar={false} />;
}

function Settings() {
	const data = useNodeData<MonitorData>();
	const { render } = useNodeControls({
		type: { value: data.type, options: ['graph', 'raw'] },
		fps: {
			value: data.fps,
			min: 1,
			max: 240,
			step: 1,
			label: 'frames per second (FPS)',
		},
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
		fps: 60,
		description: 'Debug and visualize signals',
	} satisfies Props['data'],
};
