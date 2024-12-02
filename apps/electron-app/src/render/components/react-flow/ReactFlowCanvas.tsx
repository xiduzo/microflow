import { useAutoAnimate } from '@ui/index';
import { Background, Controls, MiniMap, Panel, ReactFlow } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { NODE_TYPES } from '../../../common/nodes';
import { AppState, useReactFlowStore } from '../../stores/react-flow';
import { SerialConnectionStatusPanel } from './panels/SerialConnectionStatusPanel';

const selector = (state: AppState) => ({
	nodes: state.nodes,
	edges: state.edges,
	onNodesChange: state.onNodesChange,
	onEdgesChange: state.onEdgesChange,
	onConnect: state.onConnect,
});

export function ReactFlowCanvas() {
	const store = useReactFlowStore(useShallow(selector));
	const [animationRef] = useAutoAnimate({
		duration: 100,
	});

	return (
		<ReactFlow
			{...store}
			// @ts-expect-error
			nodeTypes={NODE_TYPES}
			colorMode="dark"
			minZoom={0.2}
			maxZoom={2}
			disableKeyboardA11y={true}
		>
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
				<section id="settings-panels" className="flex flex-col space-y-2" ref={animationRef}>
					{/* Filled by settings */}
				</section>
			</Panel>
		</ReactFlow>
	);
}
