import { type Data, type Value, dataSchema } from '@microflow/runtime/src/trigger/trigger.types';
import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { IconWithValue } from '../IconWithValue';
import { useNodeValue } from '../../../stores/node-data';
import { folder } from 'leva';

export function Trigger(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='signal' />
			<Handle type='source' position={Position.Right} id='bang' />
		</NodeContainer>
	);
}

const formatter = new Intl.NumberFormat('en-US');
function Value() {
	const data = useNodeData<Data>();
	const value = useNodeValue<Value>(false);

	return (
		<IconWithValue
			icon={data.behaviour === 'increasing' ? 'TrendingUp' : 'TrendingDown'}
			iconClassName={value ? 'text-green-500' : 'text-red-500'}
			value={`by ${formatter.format(data.threshold)}`}
			suffix={
				data.relative
					? `% within ${formatter.format(data.within / 1000)}s`
					: ` within ${formatter.format(data.within / 1000)}s`
			}
		/>
	);
}

function Settings() {
	const data = useNodeData<Data>();
	const { render } = useNodeControls({
		behaviour: {
			value: data.behaviour,
			options: {
				'when increasing': 'increasing',
				'when decreasing': 'decreasing',
			},
		},
		threshold: { value: data.threshold!, min: 0, label: 'by' },
		within: { value: data.within, min: 1, step: 50, label: 'within (ms)' },
		advanced: folder(
			{
				relative: { value: data.relative!, label: 'percentage' },
			},
			{ collapsed: true }
		),
	});

	return <>{render()}</>;
}

type Props = BaseNode<Data>;
Trigger.defaultProps = {
	data: {
		...dataSchema.parse({}),
		group: 'flow',
		tags: ['event', 'control'],
		label: 'Trigger',
		icon: 'TrendingUpIcon',
		description:
			'Send a signal when a value changes by a certain amount, like detecting a sudden change',
	} satisfies Props['data'],
};
