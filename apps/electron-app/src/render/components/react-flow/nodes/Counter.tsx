import { Position } from '@xyflow/react';
import { Handle } from './Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeHeader,
	NodeSettings,
} from './Node';

const numberFormat = new Intl.NumberFormat();

export function Counter(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeHeader className="text-4xl tabular-nums">
					{numberFormat.format(props.data.value ?? 0)}
				</NodeHeader>
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

export type CounterData = {};
type Props = BaseNode<CounterData, number>;
