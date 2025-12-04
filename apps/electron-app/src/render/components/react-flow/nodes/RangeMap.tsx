import { type Data, type Value, dataSchema } from '@microflow/runtime/src/rangemap/rangemap.types';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { useNodeValue } from '../../../stores/node-data';

const numberFormat = new Intl.NumberFormat('en-US', {
	maximumFractionDigits: 2,
});

export function RangeMap(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='from' />
			<Handle type='source' position={Position.Right} id='to' />
		</NodeContainer>
	);
}

function Value() {
	const [from, to] = useNodeValue<Value>([0, 0]);
	const data = useNodeData<Data>();

	return (
		<section className='flex grow items-center flex-col space-y-2 text-2xl'>
			<div className='grow w-full grid grid-cols-12'>
				<span className='text-xs text-muted-foreground col-span-3 flex items-center justify-center'>
					{data.from.min}
				</span>
				<span className='col-span-6 text-center'>{numberFormat.format(from)}</span>
				<span className='text-xs text-muted-foreground col-span-3 flex items-center justify-center'>
					{data.from.max}
				</span>
			</div>
			<Icons.Activity className='rotate-90 text-muted-foreground' size={16} />
			<div className='grid w-full grid-cols-12'>
				<span className='text-xs text-muted-foreground col-span-3 flex items-center justify-center'>
					{data.to.min}
				</span>
				<span className='col-span-6 text-center'>{numberFormat.format(to)}</span>
				<span className='text-xs text-muted-foreground col-span-3 flex items-center justify-center'>
					{data.to.max}
				</span>
			</div>
		</section>
	);
}

function Settings() {
	const data = useNodeData<Data>();
	const { render } = useNodeControls({
		from: { value: data.from, step: 1, joystick: false },
		to: { value: data.to, step: 1, joystick: false },
	});

	return <>{render()}</>;
}

type Props = BaseNode<Data>;
RangeMap.defaultProps = {
	data: {
		...dataSchema.parse({}),
		group: 'flow',
		tags: ['transformation'],
		icon: 'SeparatorVerticalIcon',
		label: 'Map',
		description:
			'Convert a number from one range to another, like turning a sensor reading into a brightness value',
	} satisfies Props['data'],
};
