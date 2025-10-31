import type { RangeMapData, RangeMapValueType } from '@microflow/components';
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
	const [from, to] = useNodeValue<RangeMapValueType>([0, 0]);
	const data = useNodeData<RangeMapData>();

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
	const data = useNodeData<RangeMapData>();
	const { render } = useNodeControls({
		from: { value: data.from, min: 0, max: 1023, step: 1 },
		to: { value: data.to, min: 0, max: 1023, step: 1 },
	});

	return <>{render()}</>;
}

type Props = BaseNode<RangeMapData>;
RangeMap.defaultProps = {
	data: {
		group: 'flow',
		tags: ['transformation'],
		from: { min: 0, max: 1023 },
		to: { min: 0, max: 1023 },
		label: 'Map',
		description: 'Transform a signal from one range to another',
	} satisfies Props['data'],
};
