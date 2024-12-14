import type { TriggerData, TriggerValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';

const numberFormat = new Intl.NumberFormat();

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
	const { id, data } = useNode();
	const threshold = data['threshold']; //useNodeAttribute<TriggerData>(id, 'threshold', 0);
	const behaviour = data['behaviour']; //useNodeAttribute<TriggerData>(id, 'behaviour', 0);

	let comp: string = '\u2261';
	switch (behaviour) {
		case 'exact': {
			comp = '\u2261'; // identical/exact match
			break;
		}
		case 'increasing': {
			comp = '\u003E'; // greater than
			break;
		}
		case 'decreasing': {
			comp = '\u003C'; // less than
			break;
		}
	}

	return (
		<section className="tabular-nums">
			{comp} {threshold}
		</section>
	); //{numberFormat.format(Math.round(value))}</section>;
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
