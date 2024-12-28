import { ConstantData } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { useEffect } from 'react';
import { Handle } from './Handle';
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
	const { pane, settings } = useNodeSettings<ConstantData>();

	useEffect(() => {
		if (!pane) return;

		const valueBinding = pane.addBinding(settings, 'value', {
			index: 0,
			type: 'number',
		});

		return () => {
			valueBinding.dispose();
		};
	}, [pane]);

	return null;
}

type Props = BaseNode<ConstantData>;
Constant.defaultProps = {
	data: {
		value: 4,
		group: 'flow',
		tags: ['generator'],
		label: 'Constant',
	} satisfies Props['data'],
};
