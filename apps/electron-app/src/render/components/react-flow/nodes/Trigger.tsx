import type { TriggerData, TriggerValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { Icons } from '@ui/index';

export function Trigger(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="signal" offset={-0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { data } = useNode<TriggerData>();

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
	const { pane, settings } = useNodeSettingsPane<TriggerData>();

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

type Props = BaseNode<TriggerData, TriggerValueType>;
export const DEFAULT_TRIGGER_DATA: Props['data'] = {
	label: 'Trigger',
	behaviour: 'exact',
	threshold: 0.5,
	duration: 250,
};
