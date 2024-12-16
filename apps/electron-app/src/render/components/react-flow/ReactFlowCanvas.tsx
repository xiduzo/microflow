import { Background, Controls, MiniMap, Panel, ReactFlow } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { NODE_TYPES } from '../../../common/nodes';
import { AppState, useReactFlowStore } from '../../stores/react-flow';
import { SerialConnectionStatusPanel } from './panels/SerialConnectionStatusPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { useEffect } from 'react';

const selector = (state: AppState) => ({
	nodes: state.nodes,
	edges: state.edges,
	onNodesChange: state.onNodesChange,
	onEdgesChange: state.onEdgesChange,
	onConnect: state.onConnect,
});

export function ReactFlowCanvas() {
	const store = useReactFlowStore(useShallow(selector));

	useEffect(() => {
		const originalConsoleError = console.error;

		console.error = (...args: any[]) => {
			// We are abusing the `defaultProps` to set the default values of the nodes
			if (typeof args[0] === 'string' && /defaultProps/.test(args[0])) {
				return;
			}

			originalConsoleError(...args);
		};

		return () => {
			console.error = originalConsoleError;
		};
	}, []);

	return (
		<ReactFlow {...store} nodeTypes={NODE_TYPES} colorMode="dark" minZoom={0.2} maxZoom={2}>
			<Controls />
			<MiniMap nodeBorderRadius={12} />
			<Background gap={32} />

			<Panel position="top-center">
				<SerialConnectionStatusPanel />
			</Panel>

			<Panel
				position="bottom-center"
				className="text-gray-50/20 bg-neutral-950/5 backdrop-blur-sm rounded-md"
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
		</ReactFlow>
	);
}
