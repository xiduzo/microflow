import type { TriggerData, TriggerValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
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

function Value() {
	const data = useNodeData<TriggerData>();
	const value = useNodeValue<TriggerValueType>(false);

	return (
		<IconWithValue
			icon={data.behaviour === 'increasing' ? 'TrendingUp' : 'TrendingDown'}
			iconClassName={value ? 'text-green-500' : 'text-red-500'}
			value={data.threshold}
			suffix={data.relative ? '%' : ''}
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

		return () => {
			behaviourBinding.dispose();
			thresholdBinding.dispose();
			relativeBinding.dispose();
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
		threshold: 0.5,
	} satisfies Props['data'],
};
