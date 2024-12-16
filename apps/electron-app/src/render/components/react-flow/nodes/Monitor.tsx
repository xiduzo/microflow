import { Position } from '@xyflow/react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import type { DebugValueType, MonitorData } from '@microflow/components';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect, useMemo, useRef } from 'react';
import { Pane } from '@ui/index';
import { BindingApi } from '@tweakpane/core';

export function Monitor(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="debug" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<MonitorData>();
	const value = useNodeValue<DebugValueType>(0);

	const container = useRef<HTMLDivElement>(null);
	const display = useRef({ value });

	const bindingConfig = useMemo(() => {
		switch (data.type) {
			case 'raw':
				return { rows: data.rows, multiline: true };
			case 'graph':
			default:
				return { ...data.range, view: 'graph' };
		}
	}, [
		data.type,
		(data as any).rows,
		(data as any).bufferSize,
		(data as any).range?.min,
		(data as any).range?.max,
	]);

	useEffect(() => {
		switch (data.type) {
			case 'raw':
				display.current.value = JSON.stringify(value, null, 2);
				break;
			case 'graph':
			default:
				display.current.value = Number(value);
				break;
		}
	}, [value, data.type]);

	useEffect(() => {
		const pane = new Pane({
			container: container.current ?? undefined,
		});

		pane.addBinding(display.current, 'value', {
			readonly: true,
			index: 1,
			label: '',
			interval: 1000 / 60,
			...bindingConfig,
		});

		return () => {
			pane.dispose();
		};
	}, [bindingConfig]);

	return (
		<div className="custom-tweak-pane-graph">
			<div ref={container}></div>
		</div>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettings<MonitorData>();

	useEffect(() => {
		if (!pane) return;

		let optionsBinding: BindingApi;

		function addOptionsBinding() {
			if (!pane) return;
			optionsBinding?.dispose();

			switch (settings.type) {
				case 'raw':
					settings.rows = 5;
					optionsBinding = pane.addBinding(settings, 'rows', {
						label: 'size',
						index: 1,
						min: 1,
						max: 10,
						step: 1,
					});
					break;
				case 'graph':
				default:
					settings.range = settings.range || { min: 0, max: 1023 };
					optionsBinding = pane.addBinding(settings, 'range', {
						label: 'range',
						index: 1,
					});
					break;
			}
		}

		const typeBinding = pane
			.addBinding(settings, 'type', {
				label: 'type',
				index: 0,
				view: 'list',
				options: [
					{ value: 'graph', text: 'graph' },
					{ value: 'raw', text: 'raw' },
				],
			})
			.on('change', () => {
				addOptionsBinding();
			});

		addOptionsBinding();

		return () => {
			[typeBinding, optionsBinding].forEach(disposable => disposable.dispose());
		};
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<MonitorData>;
Monitor.defaultProps = {
	data: {
		group: 'flow',
		tags: ['output', 'information'],
		label: 'Monitor',
		type: 'graph',
		range: { min: 0, max: 1023 },
	} satisfies Props['data'],
};
