import type { IntervalData, IntervalValueType } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';

const numberFormat = new Intl.NumberFormat();

export function Interval(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="start" offset={-0.5} />
			<Handle type="target" position={Position.Left} id="stop" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id } = useNode();
	const value = useNodeValue<IntervalValueType>(id, 0);

	return <section className="tabular-nums">{numberFormat.format(Math.round(value))}</section>;
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<IntervalData>();

	useEffect(() => {
		if (!pane) return;

		pane.addBinding(settings, 'interval', {
			index: 0,
			min: 500,
			max: 5000,
			step: 100,
		});
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<IntervalData, IntervalValueType>;
export const DEFAULT_INTERVAL_DATA: Props['data'] = {
	label: 'Interval',
	interval: 500,
};
