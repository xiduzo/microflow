import type { TriggerData } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { Icons } from '@ui/index';

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

	return (
		<section className="flex flex-col text-center gap-1">
			{data.behaviour === 'exact' && <Icons.Equal size={48} />}
			{data.behaviour === 'increasing' && <Icons.TrendingUp size={48} />}
			{data.behaviour === 'decreasing' && <Icons.TrendingDown size={48} />}
			<div className="text-muted-foreground text-xs">{data.threshold}</div>
		</section>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettings<TriggerData>();

	useEffect(() => {
		if (!pane) return;

		pane.addBinding(settings, 'behaviour', {
			index: 0,
			view: 'list',
			label: 'behaviour',
			options: [
				{ value: 'increasing', text: 'when increasing' },
				{ value: 'exact', text: 'when exactly equal' },
				{ value: 'decreasing', text: 'when decreasing' },
			],
		});

		pane.addBinding(settings, 'threshold', {
			index: 1,
			label: 'threshold value',
		});

		pane.addBinding(settings, 'duration', {
			index: 2,
			min: 0.1,
			max: 1000,
			step: 0.1,
			label: 'duration',
		});
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<TriggerData>;
Trigger.defaultProps = {
	data: {
		group: 'flow',
		tags: ['event', 'control'],
		label: 'Trigger',
		behaviour: 'exact',
		threshold: 0.5,
		duration: 250,
	} satisfies Props['data'],
};
