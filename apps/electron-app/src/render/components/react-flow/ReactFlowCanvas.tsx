import { Background, Controls, MiniMap, Panel, ReactFlow, useReactFlow } from '@xyflow/react';
import { NODE_TYPES } from '../../../common/nodes';
import { useReactFlowCanvas } from '../../stores/react-flow';
import { SerialConnectionStatusPanel } from './panels/SerialConnectionStatusPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { useCallback, useEffect, useRef } from 'react';
import { EDGE_TYPES } from '../../../common/edges';
import { SharePanel } from './panels/live-share/SharePanel';
import { useSocketSender } from '../../stores/socket';
import { ClientMouseMessage } from '@microflow/socket/client';

const MOUSE_DISTANCE_DEBOUNCE_OVERRIDE = 50;
const MOUSE_DEBOUNCE_DURATION = 30;

export function ReactFlowCanvas() {
	const { send } = useSocketSender();
	const store = useReactFlowCanvas();
	const { fitView, screenToFlowPosition } = useReactFlow();

	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastPositionRef = useRef<{ x: number; y: number } | null>(null);

	const debouncedSend = useCallback((data: ClientMouseMessage) => {
		const currentPos = data.data;
		const lastPos = lastPositionRef.current;
		
		const distance = lastPos 
			? Math.sqrt(Math.pow(currentPos.x - lastPos.x, 2) + Math.pow(currentPos.y - lastPos.y, 2))
			: 0;
		
		const timeoutDuration = distance > MOUSE_DISTANCE_DEBOUNCE_OVERRIDE ? 0 : MOUSE_DEBOUNCE_DURATION;
		
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			send(data);
		}, timeoutDuration);
		
		lastPositionRef.current = currentPos;
	}, [send]);

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
				debouncedSend({ type: 'mouse', data: flowPos });
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
