import {
	Background,
	Controls,
	MiniMap,
	Panel,
	ReactFlow,
	useReactFlow,
} from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { AppState, useNodesEdgesStore } from '../../store';
import { ConnectionLine } from './ConnectionLine';
import { Button } from './nodes/Button';
import { Counter } from './nodes/Counter';
import { Figma } from './nodes/Figma';
import { IfElse } from './nodes/IfElse';
import { Interval } from './nodes/Interval';
import { Led } from './nodes/Led';
import { Mqtt } from './nodes/Mqtt';
import { BaseNode } from './nodes/Node';
import { Piezo } from './nodes/piezo/Piezo';
import { RangeMap } from './nodes/RangeMap';
import { Sensor } from './nodes/Sensor';
import { Servo } from './nodes/Servo';
import { MenuButton } from './panels/MenuButton';
import { SerialConnectionStatus } from './panels/SerialConnectionStatus';

const nodeTypes = {
	Button: Button,
	Led: Led,
	Counter: Counter,
	Figma: Figma,
	Interval: Interval,
	IfElse: IfElse,
	RangeMap: RangeMap,
	Mqtt: Mqtt,
	Sensor: Sensor,
	Servo: Servo,
	Piezo: Piezo,
};

export type NodeType = keyof typeof nodeTypes;

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
			nodeTypes={nodeTypes}
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

			<Panel position="top-right">
				<MenuButton />
			</Panel>

			<Panel
				position="bottom-center"
				className="text-gray-50/20 bg-neutral-950/5 backdrop-blur-sm rounded-md p-2"
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
