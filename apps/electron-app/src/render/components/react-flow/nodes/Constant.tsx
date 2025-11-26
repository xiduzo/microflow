import { type Data, type Value, dataSchema } from '@microflow/runtime/src/constant/constant.types';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';

const numberFormat = new Intl.NumberFormat();

export function Constant(props: Props) {
	console.log(dataSchema.parse({}));

	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='source' position={Position.Right} id='output' />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<Data>();

	return <section className='text-4xl tabular-nums'>{numberFormat.format(data.value)}</section>;
}

function Settings() {
	const data = useNodeData<Data>();
	const { render } = useNodeControls({
		value: { value: data.value, step: 1 },
	});

	return <>{render()}</>;
}

type Props = BaseNode<Data>;
Constant.defaultProps = {
	data: {
		...dataSchema.parse({ value: 1337 }),
		group: 'flow',
		tags: ['generator'],
		label: 'Constant',
		icon: 'HashIcon',
		description: 'Provide a fixed number that stays the same and can be used by other nodes',
	} satisfies Props['data'],
};
