import { useEffect } from 'react';
import { useSocketListener, useSocketSender, useSocketStore } from '../../../../stores/socket';
import { useReactFlowCanvas } from '../../../../stores/react-flow';
import { User, UserProps } from '../../nodes/User';
import { useAppStore } from '../../../../stores/app';

export function useSocketManager() {
	const {
		socket,
		status,
		connections,
		createSocket,
		closeSocket,
		addConnection,
		removeConnection,
	} = useSocketStore();
	const { onNodesChange, onEdgesChange } = useReactFlowCanvas();
	const { send } = useSocketSender();
	const { user } = useAppStore();

	useSocketListener('connected', event => {
		addConnection(event.data.user);
		onNodesChange([
			{
				type: 'add',
				item: {
					...User.defaultProps,
					position: { x: 0, y: 0 },
					id: event.data.user.id,
				},
			},
		]);
	});

	useSocketListener('disconnected', event => {
		removeConnection(event.data.user);
		onNodesChange([
			{
				type: 'remove',
				id: event.data.user.id,
			},
		]);
	});

	useSocketListener('identify', event => {
		onNodesChange([
			{
				type: 'replace',
				id: event.data.user.id,
				item: {
					...User.defaultProps,
					position: { x: 0, y: 0 },
					id: event.data.user.id,
					data: {
						...User.defaultProps.data,
						user: event.data.user,
					} satisfies UserProps['data'],
				},
			},
		]);
	});

	useSocketListener('cursor', event => {
		onNodesChange([event.data.change]);
	});

	useSocketListener('node-remove', event => {
		onNodesChange([event.data.change]);
	});
	useSocketListener('node-add', event => {
		onNodesChange([event.data.change]);
	});
	useSocketListener('node-position', event => {
		onNodesChange([event.data.change]);
	});
	useSocketListener('node-data', event => {
		onNodesChange([event.data.change]);
	});

	useSocketListener('edge-remove', event => {
		onEdgesChange([event.data.change]);
	});
	useSocketListener('edge-add', event => {
		onEdgesChange([event.data.change]);
	});

	useEffect(() => {
		if (status.type !== 'shared' && status.type !== 'joined') return;

		createSocket(status.tunnelUrl);

		return () => {
			closeSocket();
		};
	}, [status, createSocket, closeSocket]);

	useEffect(() => {
		if (status.type !== 'disconnected') return;

		onNodesChange(
			connections.map(connection => ({
				type: 'remove',
				id: connection.id,
			}))
		);
	}, [status.type, connections, onNodesChange]);

	useEffect(() => {
		if (!user) return;
		if (status.type !== 'joined' && status.type !== 'shared') return;
		if (!socket?.connected) return;

		send({
			type: 'identify',
			data: user,
		});
	}, [status.type, send, user, socket?.connected]);
}
