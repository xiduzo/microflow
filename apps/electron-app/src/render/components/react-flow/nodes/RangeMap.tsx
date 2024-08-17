import type { RangeMapData, RangeMapValueType } from '@microflow/components';
import { Icons, Input } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useUpdateNodeData } from '../../../hooks/nodeUpdater';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
} from './Node';

const numberFormat = new Intl.NumberFormat('en-US', {
	maximumFractionDigits: 2,
});

export function RangeMap(props: Props) {
	const { updateNodeData } = useUpdateNodeData<RangeMapData>(props.id);

	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue
					className="text-4xl tabular-nums"
					valueOverride={props.data.value[0]}
				>
					{numberFormat.format(props.data.value[0])}
				</NodeValue>
				<section className="flex flex-col space-y-3">
					<span className="w-full flex justify-center">
						<Icons.ArrowsUpFromLine className="rotate-180" />
					</span>
				</section>
				<NodeValue
					className="text-4xl tabular-nums"
					valueOverride={props.data.value[1]}
				>
					{numberFormat.format(props.data.value[1])}
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<div>From range</div>
				<section className="flex space-x-2 justify-between items-center">
					<Input
						type="number"
						defaultValue={props.data.from[0]}
						onChange={event =>
							updateNodeData({
								from: [Number(event.target.value), props.data.from[1]],
							})
						}
					/>
					<span className="text-gray-800">-</span>
					<Input
						type="number"
						defaultValue={props.data.from[1]}
						onChange={event =>
							updateNodeData({
								from: [props.data.from[0], Number(event.target.value)],
							})
						}
					/>
				</section>
				<div>To range</div>
				<section className="flex space-x-2 justify-between items-center">
					<Input
						type="number"
						defaultValue={props.data.to[0]}
						onChange={event =>
							updateNodeData({
								to: [Number(event.target.value), props.data.to[1]],
							})
						}
					/>
					<span className="text-gray-800">-</span>
					<Input
						type="number"
						defaultValue={props.data.to[1]}
						onChange={event =>
							updateNodeData({
								to: [props.data.to[0], Number(event.target.value)],
							})
						}
					/>
				</section>
			</NodeSettings>
			<Handle type="target" position={Position.Left} id="from" />
			<Handle type="source" position={Position.Right} id="to" />
		</NodeContainer>
	);
}

type Props = BaseNode<RangeMapData, RangeMapValueType>;

export const DEFAULT_RANGE_MAP_DATA: Props['data'] = {
	value: [0, 0],
	from: [0, 100],
	to: [0, 100],
	label: 'Map',
};
