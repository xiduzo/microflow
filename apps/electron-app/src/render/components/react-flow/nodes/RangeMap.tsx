import type { RangeMapData, RangeMapValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect } from 'react';

const numberFormat = new Intl.NumberFormat('en-US', {
	maximumFractionDigits: 2,
});

export function RangeMap(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="from" />
			<Handle type="source" position={Position.Right} id="to" />
		</NodeContainer>
	);
}

function Value() {
	const { id } = useNode();
	const [from, to] = useNodeValue<Props['data']['value']>(id, [0, 0]);

	return (
		<section className="flex items-center flex-col space-y-2 text-2xl">
			<span>{numberFormat.format(from)}</span>
			<Icons.ArrowsUpFromLine className="rotate-180" size={16} />
			<span>{numberFormat.format(to)}</span>
		</section>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane();

	useEffect(() => {
		if (!pane) return;

		pane.addBinding(settings, 'from', {
			index: 0,
			step: 1,
		});

		pane.addBinding(settings, 'to', {
			index: 1,
			step: 1,
		});
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<RangeMapData, RangeMapValueType>;

export const DEFAULT_RANGE_MAP_DATA: Props['data'] = {
	value: [0, 0],
	from: { min: 0, max: 1023 },
	to: { min: 0, max: 1023 },
	label: 'Map',
};
