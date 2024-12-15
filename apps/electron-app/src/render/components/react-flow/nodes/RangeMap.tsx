import type { RangeMapData, RangeMapValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeSettings } from './Node';
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
	const [from, to] = useNodeValue<RangeMapValueType>([0, 0]);

	return (
		<section className="flex items-center flex-col space-y-2 text-2xl">
			<span>{numberFormat.format(from)}</span>
			<Icons.Activity className="rotate-90 text-muted-foreground" size={16} />
			<span>{numberFormat.format(to)}</span>
		</section>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettings();

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

type Props = BaseNode<RangeMapData>;
RangeMap.defaultProps = {
	data: {
		from: { min: 0, max: 1023 },
		to: { min: 0, max: 1023 },
		label: 'Map',
	} satisfies Props['data'],
};
