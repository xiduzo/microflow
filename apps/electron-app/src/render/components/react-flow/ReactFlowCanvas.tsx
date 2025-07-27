import {
	Background,
	Controls,
	Edge,
	Node,
	MiniMap,
	Panel,
	ReactFlow,
	useReactFlow,
} from '@xyflow/react';
import { NODE_TYPES } from '../../../common/nodes';
import { useReactFlowCanvas } from '../../stores/react-flow';
import { SerialConnectionStatusPanel } from './panels/SerialConnectionStatusPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { useCallback, useEffect, useRef } from 'react';
import { EDGE_TYPES } from '../../../common/edges';
import { SharePanel } from './panels/live-share/SharePanel';
import { useSocketSender } from '../../stores/socket';
import { UserPanel } from './panels/UserPanel';

export function ReactFlowCanvas() {
	const { send } = useSocketSender();
	const store = useReactFlowCanvas();
	const { fitView, screenToFlowPosition } = useReactFlow();
	const debounceMouseMouse = useRef<NodeJS.Timeout | null>(null);

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
			if (debounceMouseMouse.current) clearTimeout(debounceMouseMouse.current);

			debounceMouseMouse.current = setTimeout(() => {
				const flowPos = screenToFlowPosition({
					x: event.clientX,
					y: event.clientY,
				});

				send({ type: 'mouse', data: flowPos });
			}, 16);
		},
		[screenToFlowPosition, send]
	);

	const handleDelete = useCallback(
		({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
			console.log(nodes, edges);
			nodes.forEach(node => {
				send({ type: 'node-remove', data: { nodeId: node.id } });
			});
			edges.forEach(edge => {
				send({ type: 'edge-remove', data: { edgeId: edge.id } });
			});
		},
		[send]
	);

	useEffect(() => {
		fitView({ duration: 0, padding: 0.15, maxZoom: 1 });
	}, [fitView]);

	return (
		<ReactFlow
			{...store}
			onConnect={connection => {
				send({ type: 'edge-add', data: { edge: connection } });
				store.onConnect(connection);
			}}
			onNodesChange={changes => {
				changes.forEach(change => {
					console.log(change);
					switch (change.type) {
						case 'add':
							send({ type: 'node-add', data: { node: change.item } });
							break;
						case 'remove':
							send({ type: 'node-remove', data: { nodeId: change.id } });
							break;
						case 'position':
							send({
								type: 'node-position',
								data: { nodeId: change.id, position: change.position! },
							});
							break;
						case 'replace':
						case 'select':
						case 'dimensions':
							console.debug(`[REACT-FLOW] <${change.type}> not sending change over socket`, change);
							break;
						default:
							console.warn('[REACT-FLOW] <unknown node change>', change);
							break;
					}
				});
				store.onNodesChange(changes);
			}}
			onEdgesChange={changes => {
				changes.forEach(change => {
					console.log(change);
					switch (change.type) {
						case 'add':
							send({ type: 'edge-add', data: { edge: change.item } });
							break;
						case 'remove':
							send({ type: 'edge-remove', data: { edgeId: change.id } });
							break;
						case 'replace':
						case 'select':
							console.debug(`[REACT-FLOW] <${change.type}> not sending change over socket`, change);
							break;
						default:
							console.warn('[REACT-FLOW] <unknown edge change>', change);
					}
				});
				store.onEdgesChange(changes);
			}}
			onPaneMouseMove={handlePaneMouseMove}
			edgeTypes={EDGE_TYPES}
			nodeTypes={NODE_TYPES}
			colorMode={'system'}
			minZoom={0.1}
			maxZoom={2}
			selectNodesOnDrag={false}
		>
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
				<SharePanel />
			</Panel>
			<Panel position='top-right'>
				<UserPanel />
			</Panel>
		</ReactFlow>
	);
}
