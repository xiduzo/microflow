import {
	Background,
	Controls,
	MiniMap,
	Panel,
	ReactFlow,
	useReactFlow,
} from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { NODE_TYPES } from '../../../common/nodes';
import { AppState, useNodesEdgesStore } from '../../store';
import { ConnectionLine } from './ConnectionLine';
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
			connectionLineComponent={ConnectionLine}
			minZoom={0.2}
			maxZoom={1.25}
			onNodeDoubleClick={(_event, node) => {
				updateNodeData(node.id, { settingsOpen: true });
			}}
		>
			<Controls />
			<MiniMap
				nodeColor={node => {
					if (node.selected) return '#3b82f6';
					if (
						node.data.animated !== undefined &&
						node.data.value !== undefined &&
						node.data.value !== null
					)
						return '#f97316';
				}}
				nodeBorderRadius={12}
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
					className="text-center text-muted-foreground transition-all hover:opacity-100 hover:underline text-xs"
				>
					Made with ♥ by Xiduzo
				</a>
			</Panel>
		</ReactFlow>
	);
}
