import { Background, Controls, MiniMap, Panel, ReactFlow, useReactFlow } from '@xyflow/react';
import { NODE_TYPES } from '../../../common/nodes';
import { useReactFlowCanvas } from '../../stores/react-flow';
import { SerialConnectionStatusPanel } from './panels/SerialConnectionStatusPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { useEffect } from 'react';
import { EDGE_TYPES } from '../../../common/edges';
import { SharePanel } from './panels/live-share/SharePanel';
import { useSocketSender } from '../../stores/socket';

export function ReactFlowCanvas() {
	const { send } = useSocketSender();
	const store = useReactFlowCanvas();
	const { fitView, screenToFlowPosition } = useReactFlow();

	useEffect(() => {
		const originalConsoleError = console.error;

		console.error = (...args: any[]) => {
			// We are abusing the `defaultProps` to set the default values of the nodes
			if (typeof args[0] === 'string' && /defaultProps/.test(args[0])) return;

			originalConsoleError(...args);
		};

		return () => {
			console.error = originalConsoleError;
		};
	}, []);

	useEffect(() => {
		fitView({ duration: 0, padding: 0.15, maxZoom: 1 });
	}, [fitView]);

	return (
		<ReactFlow
			{...store}
			onPaneMouseMove={event => {
				const flowPos = screenToFlowPosition({
					x: event.clientX,
					y: event.clientY,
				});
				send({ type: 'mouse', data: flowPos });
			}}
			edgeTypes={EDGE_TYPES}
			nodeTypes={NODE_TYPES}
			colorMode={'system'}
			minZoom={0.1}
			maxZoom={2}
			selectNodesOnDrag={false}
		>
			<Controls />
			<MiniMap nodeBorderRadius={12} pannable />
			<Background gap={140} />

			<Panel position="top-center">
				<SerialConnectionStatusPanel />
			</Panel>

			<Panel
				position="bottom-center"
				className="dark:bg-neutral-950/5 bg-neutral-500/5 backdrop-blur-sm rounded-md"
			>
				<a
					href="https://www.sanderboer.nl"
					target="_blank"
					className="text-center text-muted-foreground transition-all hover:opacity-100 hover:underline text-xs select-none px-2"
				>
					Made with ♥ by Xiduzo
				</a>
			</Panel>

			<Panel position="top-right">
				<SettingsPanel />
			</Panel>
			<Panel position="top-left">
				<SharePanel />
			</Panel>
		</ReactFlow>
	);
}
