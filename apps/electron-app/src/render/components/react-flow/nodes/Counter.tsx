import { CounterData, CounterValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
} from './Node';

const numberFormat = new Intl.NumberFormat();

export function Counter(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="text-4xl tabular-nums">
					{numberFormat.format(props.data.value)}
				</NodeValue>
			</NodeContent>
			<NodeSettings></NodeSettings>
			<Handle type="target" position={Position.Left} id="reset" offset={1.5} />
			<Handle
				offset={0.5}
				type="target"
				position={Position.Left}
				id="decrement"
			/>
			<Handle
				offset={-0.5}
				type="target"
				position={Position.Left}
				id="increment"
			/>
			<Handle type="target" position={Position.Left} id="set" offset={-1.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

type Props = BaseNode<CounterData, CounterValueType>;
export const DEFAULT_COUNTER_DATA: Props['data'] = {
	label: 'Counter',
	value: 0,
};
