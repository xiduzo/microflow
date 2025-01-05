import { CalculateData } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { Handle } from './Handle';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Icons } from '@ui/index';

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
	const { pane, settings, setHandlesToDelete } = useNodeSettings<CalculateData>();

	useEffect(() => {
		if (!pane) return;

		const gateType = pane.addBinding(settings, 'function', {
			index: 0,
			type: 'list',
			options: [
				{ text: 'addition', value: 'add' },
				{ text: 'subtraction', value: 'subtract' },
				{ text: 'multiplication', value: 'multiply' },
				{ text: 'division', value: 'divide' },
				{ text: 'modulo', value: 'modulo' },
				{ text: 'maximum', value: 'max' },
				{ text: 'minimum', value: 'min' },
				{ text: 'round up', value: 'ceil' },
				{ text: 'round down', value: 'floor' },
				{ text: 'round closest', value: 'round' },
			],
		});

		gateType.on('change', event => {
			const hasSingleInput = ['ceil', 'floor', 'round'].includes(event.value as string);

			setHandlesToDelete(hasSingleInput ? ['2'] : []);
		});

		return () => {
			gateType.dispose();
		};
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<CalculateData>;
Calculate.defaultProps = {
	data: {
		function: 'add',
		group: 'flow',
		tags: ['transformation', 'control'],
		label: 'Calculate',
	} satisfies Props['data'],
};
