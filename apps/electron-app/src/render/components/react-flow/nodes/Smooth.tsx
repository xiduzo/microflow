import type { SmoothData } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { BindingApi } from '@tweakpane/core';
import { IconWithValue } from '../IconWithValue';

export function Smooth(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="signal" />
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<SmoothData>();

	return (
		<IconWithValue
			icon={data.type === 'movingAverage' ? 'Highlighter' : 'Eraser'}
			value={data.type === 'movingAverage' ? data.windowSize : data.attenuation}
		/>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettings<SmoothData>();

	useEffect(() => {
		if (!pane) return;

		let binding: BindingApi;

		function addBinding() {
			binding?.dispose();
			if (!pane) return;

			switch (settings.type) {
				case 'movingAverage':
					settings.windowSize = settings.windowSize ?? 25;
					binding = pane.addBinding(settings, 'windowSize', {
						index: 1,
						min: 1,
						step: 1,
						label: 'window size',
					});
					break;
				case 'smooth':
					settings.attenuation = settings.attenuation ?? 0.995;
					binding = pane.addBinding(settings, 'attenuation', {
						index: 1,
						min: 0.0,
						max: 1.0,
						step: 0.001,
						label: 'attenuation',
					});
					break;
			}
		}

		const type = pane.addBinding(settings, 'type', {
			index: 0,
			view: 'list',
			options: [
				{ value: 'smooth', text: 'Smooth' },
				{ value: 'movingAverage', text: 'Moving average' },
			],
		});

		type.on('change', () => {
			addBinding();
		});

		addBinding();

		return () => {
			binding?.dispose();
			type.dispose();
		};
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<SmoothData>;
Smooth.defaultProps = {
	data: {
		group: 'flow',
		tags: ['transformation'],
		label: 'Smooth',
		type: 'smooth',
		attenuation: 0.995,
		description: 'Smooth incoming signals to reduce noise',
	} satisfies Props['data'],
};
