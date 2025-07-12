import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import type { DebugValueType, MonitorData } from '@microflow/components';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect, useRef, useState } from 'react';
import { Pane } from '@ui/index';
import { BindingParams } from '@tweakpane/core';
import { useUploadResult } from '../../../stores/board';

export function Monitor(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="debug" />
		</NodeContainer>
	);
}

const BASE_GRAPH_RANGE = {
	min: 0,
	max: 0.0001,
};

const graphNumberFormat = new Intl.NumberFormat('en-US', {
	maximumFractionDigits: 2,
});
function Value() {
	const data = useNodeData<MonitorData>();
	const uploadResult = useUploadResult();
	const value = useNodeValue<DebugValueType>(data.type === 'graph' ? 0 : '');

	const container = useRef<HTMLDivElement>(null);
	const display = useRef({ value });
	const binding = useRef<{ min: number; max: number }>();
	const [minMax, setMinMax] = useState(BASE_GRAPH_RANGE);

	useEffect(() => {
		switch (data.type) {
			case 'raw':
				if (typeof value === 'string') {
					display.current.value = value;
				} else {
					display.current.value = JSON.stringify(value, null, 2);
				}
				break;
			case 'graph':
			default:
				const numericalValue = Number(value);
				display.current.value = numericalValue;
				if (!binding.current) return;
				binding.current.min = Math.min(binding.current.min ?? BASE_GRAPH_RANGE.min, numericalValue);
				binding.current.max = Math.max(binding.current.max ?? BASE_GRAPH_RANGE.max, numericalValue);
				setMinMax(prev => {
					if (!binding.current) return prev;
					if (prev.min === binding.current.min && prev.max === binding.current.max) return prev;

					return { min: binding.current.min, max: binding.current.max };
				});
				break;
		}
	}, [value, data.type]);

	useEffect(() => {
		if (!binding.current) return;
		if (uploadResult !== 'ready') return;

		binding.current.min = BASE_GRAPH_RANGE.min;
		binding.current.max = BASE_GRAPH_RANGE.max;
		setMinMax(BASE_GRAPH_RANGE);
	}, [uploadResult]);

	useEffect(() => {
		const pane = new Pane({
			container: container.current ?? undefined,
		});

		const baseProps: BindingParams = {
			index: 1,
			readonly: true,
			label: '',
			interval: 1000 / 60,
		};

		switch (data.type) {
			case 'raw':
				pane.addBinding(display.current, 'value', {
					...baseProps,
					rows: 5,
					multiline: true,
				});
				break;
			case 'graph':
			default:
				// @ts-expect-error - Some TS wizzardry
				binding.current = pane.addBinding(display.current, 'value', {
					...baseProps,
					...BASE_GRAPH_RANGE,
					view: 'graph',
				});

				break;
		}

		return () => {
			pane.dispose();
		};
	}, [data.type]);

	return (
		<div className="custom-tweak-pane-graph">
			{data.type === 'graph' && (
				<div className="text-muted-foreground text-xs tabular-nums px-4 text-right">
					{graphNumberFormat.format(minMax.max)}
				</div>
			)}
			<div ref={container}></div>
			{data.type === 'graph' && (
				<div className="text-muted-foreground text-xs tabular-nums px-4 text-right">
					{graphNumberFormat.format(minMax.min)}
				</div>
			)}
		</div>
	);
}

function Settings() {
	const data = useNodeData<MonitorData>();
	const { render } = useNodeControls({
		type: { value: data.type, options: ['graph', 'raw'] },
	});

	return <>{render()}</>;
}

type Props = BaseNode<MonitorData>;
Monitor.defaultProps = {
	data: {
		group: 'flow',
		tags: ['output', 'information'],
		label: 'Monitor',
		type: 'graph',
		description: 'Debug and visualize signals',
	} satisfies Props['data'],
};
