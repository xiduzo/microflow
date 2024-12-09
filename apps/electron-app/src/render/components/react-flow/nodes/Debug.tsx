import { Position } from '@xyflow/react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import type { DebugValueType, DebugData } from '@microflow/components';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect, useMemo, useRef } from 'react';
import { Pane } from '@ui/index';
import { BindingApi } from '@tweakpane/core';

export function Debug(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="debug" />
		</NodeContainer>
	);
}

function Value() {
	const { id, data } = useNode<DebugData>();
	const value = useNodeValue<DebugValueType>(id, 0);

	const container = useRef<HTMLDivElement>(null);
	const display = useRef({ value });

	const bindingConfig = useMemo(() => {
		switch (data.type) {
			case 'object':
				return { rows: data.rows, multiline: true };
			case 'string':
				return { bufferSize: data.bufferSize };
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
			case 'object':
				display.current.value = JSON.stringify(value, null, 2);
				break;
			case 'string':
				display.current.value = value;
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
	const { pane, settings } = useNodeSettingsPane<DebugData>();

	useEffect(() => {
		if (!pane) return;

		let optionsBinding: BindingApi;

		function addOptionsBinding() {
			if (!pane) return;
			optionsBinding?.dispose();

			switch (settings.type) {
				case 'string':
					settings.bufferSize = settings.bufferSize || 10;
					optionsBinding = pane.addBinding(settings, 'bufferSize', {
						label: 'size',
						index: 1,
						min: 1,
						step: 1,
					});
					break;
				case 'object':
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
					{ value: 'string', text: 'string' },
					{ value: 'object', text: 'object' },
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

type Props = BaseNode<DebugData, DebugValueType>;
export const DEFAULT_DEBUG_DATA: Props['data'] = {
	label: 'Debug',
	type: 'graph',
	range: { min: 0, max: 1023 },
};
