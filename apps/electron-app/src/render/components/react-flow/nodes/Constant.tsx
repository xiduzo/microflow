import { ConstantData } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';

const numberFormat = new Intl.NumberFormat();

export function Constant(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="source" position={Position.Right} id="output" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<ConstantData>();

	return <section className="text-4xl tabular-nums">{numberFormat.format(data.value)}</section>;
}

function Settings() {
	const data = useNodeData<ConstantData>();
	const { render } = useNodeControls({
		value: { value: data.value },
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
		description: 'Generate a constant signal output',
	} satisfies Props['data'],
};
