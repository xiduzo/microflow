import { useCallback, useEffect } from 'react';
import { useSocketListener, useSocketStore } from '../../../../stores/socket';
import { useReactFlowCanvas } from '../../../../stores/react-flow';
import { User, UserProps } from '../../nodes/User';
import { ServerMessage, ServerMouseMessage } from '@microflow/socket/client';
import { useReactFlow } from '@xyflow/react';

export function useSocketManager() {
	const { status, connections, createSocket, closeSocket, addConnection, removeConnection } = useSocketStore();
	const { onNodesChange } = useReactFlowCanvas();
	const { getZoom } = useReactFlow();

	const handleConnection = useCallback((event: ServerMessage) => {
		addConnection(event.data.user);
		onNodesChange([{
			type: 'add',
			item: {
				...User.defaultProps,
				position: { x: 0, y: 0 },
				id: event.data.user.id,
				data: {
					...User.defaultProps.data,
					user: event.data.user,
				} satisfies UserProps['data']
			}
		}]);
	} ,[])
	useSocketListener('connected', handleConnection);

	const handleDisconnection = useCallback((event: ServerMessage) => {
		removeConnection(event.data.user);
		onNodesChange([{
				type: 'remove',
				id: event.data.user.id,
			}]);
		}, []);
	useSocketListener('disconnected', handleDisconnection);

	const handleIdentify = useCallback((event: ServerMessage) => {
		onNodesChange([{
			type: 'replace',
			id: event.data.user.id,
			item: {
				...User.defaultProps,
				position: { x: 0, y: 0 },
				id: event.data.user.id,
				data: {
					...User.defaultProps.data,
					user: event.data.user,
				} satisfies UserProps['data']
			}
		}]);
	}, []);
	useSocketListener('identify', handleIdentify);

	const handleMouse = useCallback((event: ServerMouseMessage) => {
		onNodesChange([{
			id: event.data.user.id,
			type: 'position',
			position: event.data,
		}]);
	}, []);
	useSocketListener('mouse', handleMouse);


	useEffect(() => {
		if (status.type !== 'shared' && status.type !== 'joined') return;

		createSocket(status.tunnelUrl);

		return () => {
			closeSocket();
		};
	}, [status, createSocket, closeSocket]);

	useEffect(() => {
		if (status.type !== 'disconnected') return;

		onNodesChange(connections.map(connection => ({
			type: 'remove',
			id: connection.id,
		})));
	}, [status.type, connections, onNodesChange]);
}
