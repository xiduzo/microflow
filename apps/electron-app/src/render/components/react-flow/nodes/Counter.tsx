import { type Data, type Value, dataSchema } from '@microflow/runtime/src/counter/counter.types';
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
	const value = useNodeValue<Value>(0);

	return <section className='text-4xl tabular-nums'>{numberFormat.format(value)}</section>;
}

function Settings() {
	const { render } = useNodeControls({});

	return <>{render()}</>;
}

type Props = BaseNode<Data>;
Counter.defaultProps = {
	data: {
		...dataSchema.parse({}),
		group: 'flow',
		tags: ['control', 'information'],
		label: 'Counter',
		icon: 'Tally5Icon',
		description: 'Keep track of a number that can be increased, decreased, set, or reset',
	} satisfies Props['data'],
};
