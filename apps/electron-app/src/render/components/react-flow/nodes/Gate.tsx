import { Position } from '@xyflow/react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { type GateData, type GateValueType } from '@microflow/components';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect } from 'react';
import { Icons } from '@ui/index';
import { uuid } from '../../../../utils/uuid';

export function Gate(props: Props) {
	function getOffset(index: number) {
		return index - (props.data.inputs - 1) / 2;
	}

	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			{Array.from({ length: props.data.inputs }).map((_item, index) => {
				return (
					<Handle
						key={uuid()}
						type="target"
						title={`Check ${index + 1}`}
						position={Position.Left}
						id={String(index)}
						offset={getOffset(index)}
					/>
				);
			})}
			<Handle type="source" position={Position.Right} id="true" offset={-0.5} />
			<Handle type="source" position={Position.Right} id="false" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<GateData>();
	const value = useNodeValue<GateValueType>(false);

	return <GateIcon gate={data.gate} className={`${value ? 'text-green-500' : 'text-red-500'}`} />;
}

function Settings() {
	const { pane, settings, setHandlesToDelete } = useNodeSettings<GateData>();

	useEffect(() => {
		if (!pane) return;

		const initialAmount = Number(settings.inputs);

		pane.addBinding(settings, 'gate', {
			index: 0,
			type: 'list',
			options: [
				{ text: 'not', value: 'not' },
				{ text: 'and', value: 'and' },
				{ text: 'nand', value: 'nand' },
				{ text: 'or', value: 'or' },
				{ text: 'nor', value: 'nor' },
				{ text: 'xor', value: 'xor' },
				{ text: 'xnor', value: 'xnor' },
			],
		});

		pane
			.addBinding(settings, 'inputs', {
				index: 1,
				min: 2,
				step: 1,
				max: 4,
			})
			.on('change', ({ value }) => {
				if (value === initialAmount) {
					setHandlesToDelete([]);
					return;
				}

				setHandlesToDelete(Array.from({ length: value }).map((_, index) => String(index)));
			});
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<GateData>;
Gate.defaultProps = {
	data: {
		label: 'Gate',
		gate: 'and',
		inputs: 2,
	} satisfies Props['data'],
};

const DEFAULT_ICON_SIZE = 60;
function GateIcon(props: { gate: GateData['gate']; size?: number; className?: string }) {
	switch (props.gate) {
		case 'not':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path d="M6 6L6 18L14 12L6 6Z" stroke="currentColor" strokeWidth="2" />
					<circle cx="17" cy="12" r="2" stroke="currentColor" strokeWidth="2" />
				</svg>
			);
		case 'and':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						d="M6 6H12C15.3137 6 18 8.68629 18 12C18 15.3137 15.3137 18 12 18H6V6Z"
						stroke="currentColor"
						strokeWidth="2"
					/>
				</svg>
			);
		case 'nand':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						d="M6 6H12C15.3137 6 18 8.68629 18 12C18 15.3137 15.3137 18 12 18H6V6Z"
						stroke="currentColor"
						strokeWidth="2"
					/>
					<circle cx="20" cy="12" r="2" stroke="currentColor" strokeWidth="2" />
				</svg>
			);
		case 'or':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						d="M6 6C10 6 14 6 18 12C14 18 10 18 6 18C10 12 10 12 6 6Z"
						stroke="currentColor"
						strokeWidth="2"
					/>
				</svg>
			);
		case 'nor':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						d="M6 6C10 6 13 6 16 12C13 18 10 18 6 18C10 12 10 12 6 6Z"
						stroke="currentColor"
						strokeWidth="2"
					/>
					<circle cx="18" cy="12" r="2" stroke="currentColor" strokeWidth="2" />
				</svg>
			);
		case 'xor':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						d="M8 6C12 6 16 6 20 12C16 18 12 18 8 18C12 12 12 12 8 6Z"
						stroke="currentColor"
						strokeWidth="2"
					/>
					<path d="M4 6C8 12 8 12 4 18" stroke="currentColor" strokeWidth="2" />
				</svg>
			);
		case 'xnor':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						d="M8 6C11 6 14 6 16 12C14 18 11 18 8 18C11 12 11 12 8 6Z"
						stroke="currentColor"
						strokeWidth="2"
					/>
					<path d="M4 6C8 12 8 12 4 18" stroke="currentColor" strokeWidth="2" />
					<circle cx="18" cy="12" r="2" stroke="currentColor" strokeWidth="2" />
				</svg>
			);
		default:
			return <div>...</div>;
	}
}
