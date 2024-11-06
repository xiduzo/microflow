import { Background, Controls, MiniMap, Panel, ReactFlow, useReactFlow } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { NODE_TYPES } from '../../../common/nodes';
import { AppState, useNodesEdgesStore } from '../../store';
import { BaseNode } from './nodes/Node';
import { SerialConnectionStatus } from './panels/SerialConnectionStatus';

const selector = (state: AppState) => ({
	nodes: state.nodes,
	edges: state.edges,
	onNodesChange: state.onNodesChange,
	onEdgesChange: state.onEdgesChange,
	onConnect: state.onConnect,
});

export function ReactFlowCanvas() {
	const store = useNodesEdgesStore(useShallow(selector));
	const { updateNodeData } = useReactFlow<BaseNode>();

	return (
		<ReactFlow
			{...store}
			// @ts-expect-error
			nodeTypes={NODE_TYPES}
			colorMode="dark"
			minZoom={0.2}
			maxZoom={2}
			onNodeDoubleClick={(_event, node) => {
				if ('settingsOpen' in node.data && node.data.settingsOpen === true) {
					return;
				}

				updateNodeData(node.id, { settingsOpen: true });
			}}
			disableKeyboardA11y={true}
		>
			<Controls />
			<MiniMap
				nodeBorderRadius={12}
				nodeClassName={node => {
					if (node.data.animated) return 'animated';
				}}
			/>
			<Background gap={32} />

			<Panel position="top-center">
				<SerialConnectionStatus />
			</Panel>

			<Panel
				position="bottom-center"
				className="text-gray-50/20 bg-neutral-950/5 backdrop-blur-sm rounded-md"
			>
				<a
					href="https://www.sanderboer.nl"
					target="_blank"
					className="text-center text-muted-foreground transition-all hover:opacity-100 hover:underline text-xs select-none"
				>
					Made with ♥ by Xiduzo
				</a>
			</Panel>
		</ReactFlow>
	);
}
