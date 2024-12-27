import type { SmoothData } from '@microflow/components';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
import { BindingApi } from '@tweakpane/core';
import { Icons } from '@ui/index';

export function Smooth(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="signal" offset={-0.5} />
			<Handle type="source" position={Position.Right} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<SmoothData>();

	if (data.type === 'movingAverage') {
		return (
			<section className="flex flex-col text-center gap-1">
				<Icons.Highlighter size={48} />
				<div className="text-muted-foreground text-xs">{data.windowSize}</div>
			</section>
		);
	}

	return (
		<section className="flex flex-col text-center gap-1">
			<Icons.Eraser size={48} />
			<div className="text-muted-foreground text-xs">{data.attenuation.toFixed(3)}</div>
		</section>
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
					settings.windowSize = settings.windowSize ?? 1;
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
			console.log(settings.type);
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
	} satisfies Props['data'],
};
