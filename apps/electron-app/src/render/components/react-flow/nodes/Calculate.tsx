import { CalculateData } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { Handle } from './Handle';
import { Position } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { Icons } from '@ui/index';

export function Calculate(props: Props) {
	const hasSingleInput = ['ceil', 'floor', 'round'].includes(props.data.function as string);

	const [first, second] = useMemo(() => {
		switch (props.data.function) {
			case 'add':
				return ['first addend', 'second addend'];
			case 'subtract':
				return ['minuend', 'subtrahend'];
			case 'multiply':
				return ['first factor', 'second factor'];
			case 'divide':
				return ['dividend', 'divisor'];
			case 'modulo':
				return ['dividend', 'divisor'];
			case 'max':
				return ['first operand', 'second operand'];
			case 'min':
				return ['first operand', 'second operand'];
			default:
				return ['input', 'input'];
		}
	}, [props.data.function]);

	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />

			<Handle
				type="target"
				position={Position.Left}
				id="1"
				title={first}
				offset={!hasSingleInput ? -0.5 : 0}
			/>
			{!hasSingleInput && (
				<Handle type="target" position={Position.Left} id="2" title={second} offset={0.5} />
			)}
			<Handle type="source" position={Position.Right} id="change" />
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
				{ text: 'add', value: 'add' },
				{ text: 'subtract', value: 'subtract' },
				{ text: 'multiply', value: 'multiply' },
				{ text: 'divide', value: 'divide' },
				{ text: 'modulo', value: 'modulo' },
				{ text: 'max', value: 'max' },
				{ text: 'min', value: 'min' },
				{ text: 'round up', value: 'ceil' },
				{ text: 'round down', value: 'floor' },
				{ text: 'round', value: 'round' },
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
