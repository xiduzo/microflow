import { ConstantData } from '@microflow/hardware';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';

const numberFormat = new Intl.NumberFormat();

export function Constant(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='source' position={Position.Right} id='output' />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<ConstantData>();

	return <section className='text-4xl tabular-nums'>{numberFormat.format(data.value)}</section>;
}

function Settings() {
	const data = useNodeData<ConstantData>();
	const { render } = useNodeControls({
		value: { value: data.value, step: 1 },
	});

	return <>{render()}</>;
}

type Props = BaseNode<ConstantData>;
Constant.defaultProps = {
	data: {
		value: 4,
		group: 'flow',
		tags: ['generator'],
		label: 'Constant',
		icon: 'HashIcon',
		description: 'Provide a fixed number that stays the same and can be used by other nodes',
	} satisfies Props['data'],
};
