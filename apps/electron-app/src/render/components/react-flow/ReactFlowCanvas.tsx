import { Background, Controls, MiniMap, Panel, ReactFlow, useReactFlow } from '@xyflow/react';
import { NODE_TYPES } from '../../../common/nodes';
import { useReactFlowCanvas } from '../../stores/react-flow';
import { SerialConnectionStatusPanel } from './panels/SerialConnectionStatusPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { useCallback, useEffect, useRef } from 'react';
import { EDGE_TYPES } from '../../../common/edges';
import { CollaborationPanel } from './panels/CollaborationPanel';
import { UserPanel } from './panels/UserPanel';
import { useCursorTracking } from '../../stores/yjs';
import { UserCursorSync } from './UserCursorSync';
import { UserCursorOverlay } from './UserCursorOverlay';

export function ReactFlowCanvas() {
	const store = useReactFlowCanvas();
	const { fitView, screenToFlowPosition } = useReactFlow();
	const debounceCursorPostion = useRef<NodeJS.Timeout | undefined>(undefined);
	const { updateLocalCursor } = useCursorTracking();

	useEffect(() => {
		const originalConsoleError = console.error;

		console.error = (...args: unknown[]) => {
			// We are abusing the `defaultProps` to set the default values of the nodes
			if (typeof args[0] === 'string' && /defaultProps/.test(args[0])) return;

			originalConsoleError(...args);
		};

		return () => {
			console.error = originalConsoleError;
		};
	}, []);

	const handlePaneMouseMove = useCallback(
		(event: React.MouseEvent<Element, MouseEvent>) => {
			clearTimeout(debounceCursorPostion.current);

			debounceCursorPostion.current = setTimeout(() => {
				const position = screenToFlowPosition({
					x: event.clientX,
					y: event.clientY,
				});

				// Update local cursor position for peer collaboration
				updateLocalCursor(position);
			}, 16);
		},
		[screenToFlowPosition, updateLocalCursor]
	);

	useEffect(() => {
		fitView({ duration: 0, padding: 0.15, maxZoom: 1 });
	}, [fitView]);

	return (
		<ReactFlow
			{...store}
			onPaneMouseMove={handlePaneMouseMove}
			edgeTypes={EDGE_TYPES}
			nodeTypes={NODE_TYPES}
			colorMode={'system'}
			minZoom={0.1}
			maxZoom={2}
			selectNodesOnDrag={false}
		>
			<UserCursorSync />
			<UserCursorOverlay />
			<Controls />
			<MiniMap
				nodeBorderRadius={12}
				pannable
				nodeClassName={node => `react-flow__minimap-node__${node.type ?? ''}`}
			/>
			<Background gap={140} />

			<Panel position='top-center'>
				<SerialConnectionStatusPanel />
			</Panel>

			<Panel
				position='bottom-center'
				className='dark:bg-neutral-950/5 bg-neutral-500/5 backdrop-blur-sm rounded-md'
			>
				<a
					href='https://www.sanderboer.nl'
					target='_blank'
					className='text-center text-muted-foreground transition-all hover:opacity-100 hover:underline text-xs select-none px-2'
				>
					Made with ♥ by Xiduzo
				</a>
			</Panel>

			<Panel position='top-right'>
				<SettingsPanel />
			</Panel>
			<Panel position='top-left'>
				<CollaborationPanel />
			</Panel>
			<Panel position='top-right'>
				<UserPanel />
			</Panel>
		</ReactFlow>
	);
}
