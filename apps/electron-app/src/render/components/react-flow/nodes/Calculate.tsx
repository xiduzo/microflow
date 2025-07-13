import { CalculateData } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';
import { Icons } from '@microflow/ui';

export function Calculate(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />

			<Handle type="target" position={Position.Left} id="input" />
			<Handle type="source" position={Position.Right} id="change" title="result" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<CalculateData>();

	switch (data.function) {
		case 'add':
			return <Icons.Plus size={48} className="text-muted-foreground" />;
		case 'subtract':
			return <Icons.Minus size={48} className="text-muted-foreground" />;
		case 'multiply':
			return <Icons.X size={48} className="text-muted-foreground" />;
		case 'divide':
			return <Icons.Divide size={48} className="text-muted-foreground" />;
		case 'modulo':
			return <Icons.Percent size={48} className="text-muted-foreground" />;
		case 'max':
			return <Icons.ArrowUpToLine size={48} className="text-muted-foreground" />;
		case 'min':
			return <Icons.ArrowDownToLine size={48} className="text-muted-foreground" />;
		case 'ceil':
			return <Icons.ChevronUp size={48} className="text-muted-foreground" />;
		case 'floor':
			return <Icons.ChevronDown size={48} className="text-muted-foreground" />;
		case 'round':
			return <Icons.ChevronsUpDown size={48} className="text-muted-foreground" />;
		default:
			return <Icons.CircleHelp size={48} className="text-muted-foreground" />;
	}
}

function Settings() {
	const data = useNodeData<CalculateData>();
	const { render } = useNodeControls({
		function: {
			value: data.function,
			options: {
				addition: 'add',
				subtraction: 'subtract',
				multiplication: 'multiply',
				division: 'divide',
				modulo: 'modulo',
				maximum: 'max',
				minimum: 'min',
				'round up': 'ceil',
				'round down': 'floor',
				'round closest': 'round',
			},
		},
	});

	return <>{render()}</>;
}

type Props = BaseNode<CalculateData>;
Calculate.defaultProps = {
	data: {
		function: 'add',
		group: 'flow',
		tags: ['transformation', 'control'],
		label: 'Calculate',
		description: 'Performs math operations on signals',
	} satisfies Props['data'],
};
