import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { type GateData, type GateValueType } from '@microflow/hardware';
import { useNodeValue } from '../../../stores/node-data';
import { uid } from '../../../../common/uuid';

export function Gate(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id={'check'} />
			<Handle type='source' position={Position.Right} id='true' offset={-1} />
			<Handle type='source' position={Position.Right} id='change' />
			<Handle type='source' position={Position.Right} id='false' offset={1} />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<GateData>();
	const value = useNodeValue<GateValueType>(false);

	return (
		<section className='flex flex-col text-center items-center text-muted-foreground'>
			<GateIcon gate={data.gate} className={`${value ? 'text-green-500' : 'text-red-500'}`} />
			<div className='text-xs tabular-nums'>{data.gate}</div>
		</section>
	);
}

function Settings() {
	const data = useNodeData<GateData>();
	const { render } = useNodeControls({
		gate: {
			value: data.gate,
			options: ['and', 'nand', 'or', 'nor', 'xor', 'xnor'],
		},
	});

	return <>{render()}</>;
}

type Props = BaseNode<GateData>;
Gate.defaultProps = {
	data: {
		group: 'flow',
		tags: ['control'],
		label: 'Gate',
		icon: 'CircuitBoardIcon',
		gate: 'and',
		description:
			'Combine multiple signals together using simple rules to make decisions',
	} satisfies Props['data'],
};

const DEFAULT_ICON_SIZE = 60;
function GateIcon(props: { gate: GateData['gate']; size?: number; className?: string }) {
	switch (props.gate) {
		case 'and':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox='0 0 24 24'
					fill='none'
					xmlns='http://www.w3.org/2000/svg'
				>
					<path
						d='M6 6H12C15.3137 6 18 8.68629 18 12C18 15.3137 15.3137 18 12 18H6V6Z'
						stroke='currentColor'
						strokeWidth='2'
					/>
				</svg>
			);
		case 'nand':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox='0 0 24 24'
					fill='none'
					xmlns='http://www.w3.org/2000/svg'
				>
					<path
						d='M6 6H12C15.3137 6 18 8.68629 18 12C18 15.3137 15.3137 18 12 18H6V6Z'
						stroke='currentColor'
						strokeWidth='2'
					/>
					<circle cx='20' cy='12' r='2' stroke='currentColor' strokeWidth='2' />
				</svg>
			);
		case 'or':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox='0 0 24 24'
					fill='none'
					xmlns='http://www.w3.org/2000/svg'
				>
					<path
						d='M6 6C10 6 14 6 18 12C14 18 10 18 6 18C10 12 10 12 6 6Z'
						stroke='currentColor'
						strokeWidth='2'
					/>
				</svg>
			);
		case 'nor':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox='0 0 24 24'
					fill='none'
					xmlns='http://www.w3.org/2000/svg'
				>
					<path
						d='M6 6C10 6 13 6 16 12C13 18 10 18 6 18C10 12 10 12 6 6Z'
						stroke='currentColor'
						strokeWidth='2'
					/>
					<circle cx='18' cy='12' r='2' stroke='currentColor' strokeWidth='2' />
				</svg>
			);
		case 'xor':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox='0 0 24 24'
					fill='none'
					xmlns='http://www.w3.org/2000/svg'
				>
					<path
						d='M8 6C12 6 16 6 20 12C16 18 12 18 8 18C12 12 12 12 8 6Z'
						stroke='currentColor'
						strokeWidth='2'
					/>
					<path d='M4 6C8 12 8 12 4 18' stroke='currentColor' strokeWidth='2' />
				</svg>
			);
		case 'xnor':
			return (
				<svg
					className={props.className}
					width={props.size ?? DEFAULT_ICON_SIZE}
					height={props.size ?? DEFAULT_ICON_SIZE}
					viewBox='0 0 24 24'
					fill='none'
					xmlns='http://www.w3.org/2000/svg'
				>
					<path
						d='M8 6C11 6 14 6 16 12C14 18 11 18 8 18C11 12 11 12 8 6Z'
						stroke='currentColor'
						strokeWidth='2'
					/>
					<path d='M4 6C8 12 8 12 4 18' stroke='currentColor' strokeWidth='2' />
					<circle cx='18' cy='12' r='2' stroke='currentColor' strokeWidth='2' />
				</svg>
			);
		default:
			return <div>...</div>;
	}
}
