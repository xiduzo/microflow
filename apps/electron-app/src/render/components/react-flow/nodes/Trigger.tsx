import type { TriggerData, TriggerValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { IconWithValue } from '../IconWithValue';
import { useNodeValue } from '../../../stores/node-data';

export function Trigger(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="signal" />
			<Handle type="source" position={Position.Right} id="bang" />
		</NodeContainer>
	);
}

const formatter = new Intl.NumberFormat('en-US');
function Value() {
	const data = useNodeData<TriggerData>();
	const value = useNodeValue<TriggerValueType>(false);

	return (
		<IconWithValue
			icon={data.behaviour === 'increasing' ? 'TrendingUp' : 'TrendingDown'}
			iconClassName={value ? 'text-green-500' : 'text-red-500'}
			value={`by ${data.threshold}`}
			suffix={
				data.relative
					? `% within ${formatter.format(data.within / 1000)}s`
					: ` within ${formatter.format(data.within / 1000)}s`
			}
		/>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettings<TriggerData>();

	useEffect(() => {
		if (!pane) return;

		const behaviourBinding = pane.addBinding(settings, 'behaviour', {
			index: 0,
			view: 'list',
			label: 'triggers',
			options: [
				{ value: 'increasing', text: 'when increasing' },
				{ value: 'decreasing', text: 'when decreasing' },
			],
		});

		const thresholdBinding = pane.addBinding(settings, 'threshold', {
			index: 1,
			label: 'by',
			min: 0,
		});

		const relativeBinding = pane.addBinding(settings, 'relative', {
			index: 2,
			label: 'percentage',
		});

		settings.within ??= 250;
		const withinBinding = pane.addBinding(settings, 'within', {
			index: 3,
			label: 'within (ms)',
			min: 1,
		});

		return () => {
			behaviourBinding.dispose();
			thresholdBinding.dispose();
			relativeBinding.dispose();
			withinBinding.dispose();
		};
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<TriggerData>;
Trigger.defaultProps = {
	data: {
		group: 'flow',
		tags: ['event', 'control'],
		label: 'Trigger',
		relative: false,
		behaviour: 'decreasing',
		threshold: 5,
		within: 250,
		description: 'Emit a signal when a threshold condition is met',
	} satisfies Props['data'],
};
