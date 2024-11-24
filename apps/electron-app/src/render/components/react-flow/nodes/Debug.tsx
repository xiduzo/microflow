import { Position } from '@xyflow/react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import type { DebugValueType, DebugData } from '@microflow/components';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect, useRef } from 'react';
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

	const container = useRef<HTMLDivElement>();
	const display = useRef({ value: 0 as unknown });

	useEffect(() => {
		display.current.value = data.type === 'graph' ? Number(value) : value;
	}, [value, data.type]);

	useEffect(() => {
		const pane = new Pane({
			container: container.current,
		});

		pane.addBinding(display.current, 'value', {
			readonly: true,
			index: 1,
			label: '',
			view: data.type === 'graph' ? 'graph' : '',
			...(data.type === 'graph' ? data.range : { bufferSize: data.bufferSize }),
		});

		return () => {
			pane.dispose();
		};
	}, [data]);

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
			optionsBinding?.dispose();

			switch (settings.type) {
				case 'log':
					settings.bufferSize = settings.bufferSize || 10;
					optionsBinding = pane.addBinding(settings, 'bufferSize', {
						label: 'size',
						index: 1,
						min: 1,
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
			}
		}

		const typeBinding = pane
			.addBinding(settings, 'type', {
				label: 'type',
				index: 0,
				view: 'list',
				options: [
					{ value: 'graph', text: 'graph' },
					{ value: 'log', text: 'log' },
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
