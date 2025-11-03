import type { CounterData, CounterValueType } from '@microflow/hardware';
import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls } from './Node';
import { useNodeValue } from '../../../stores/node-data';

const numberFormat = new Intl.NumberFormat();

export function Counter(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='increment' offset={-1.5} />
			<Handle type='target' position={Position.Left} id='set' offset={-0.5} />
			<Handle type='target' position={Position.Left} id='decrement' offset={0.5} />
			<Handle type='target' position={Position.Left} id='reset' offset={1.5} />
			<Handle type='source' position={Position.Right} id='change' />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<CounterValueType>(0);

	return <section className='text-4xl tabular-nums'>{numberFormat.format(value)}</section>;
}

function Settings() {
	const { render } = useNodeControls({});

	return <>{render()}</>;
}

type Props = BaseNode<CounterData>;
Counter.defaultProps = {
	data: {
		group: 'flow',
		tags: ['event', 'information'],
		label: 'Counter',
		description: 'Track and manipulate a numerical value',
	} satisfies Props['data'],
};
