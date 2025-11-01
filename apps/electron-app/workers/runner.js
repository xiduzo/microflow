const MicroflowComponents = require('@microflow/components');
const { Board, TcpSerial, BaseComponent } = require('@microflow/components');
const { Edge, Node } = require('@xyflow/react');

const port = process?.argv?.at(-1);

if (!port) {
	console.info(
		JSON.stringify({
			type: 'info',
			message:
				'No port provided, johnny five usualy can handle this. This might cause unforseen behavior.',
		})
	);
}

function stdout(data) {
	process.send(data);
}

/**
 * Map of component instances by node ID.
 * @type {Map<string, BaseComponent>}
 */
const nodes = new Map();

/**
 * @typedef {string} EdgeConnection
 * @description A connection identifier in the format `${string}_${string}_${string}`,
 * where each segment is a string joined by underscores. This represents the connection
 * between a source node's action/output and its handlers.
 * @pattern /^.+_.+_.+$/
 * @example "interval_node123_on"
 */

/**
 * Map of event unsubscribers by edge connection identifier.
 * @type {Map<EdgeConnection, Function>}
 */
const unsubscribers = new Map();

try {
	const ipRegex = new RegExp(
		/^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/
	);
	let connection;

	if (ipRegex.test(port)) {
		connection = new TcpSerial({ host: port, port: 3030 });

		connection.on('close', () =>
			stdout({
				type: 'close',
				message: `Connection not reachable on ${port}`,
				class: TcpSerial.name,
			})
		);
	}

	const board = new Board({
		repl: false,
		debug: true,
		port: connection || port,
	});

	// This event will emit after the connect event and only when the Board instance object has completed
	// any hardware initialization that must take place before the program can operate.
	// This process is asynchronous, and completion is signified to the program via a "ready" event
	// For on-board execution, ready should emit after connect.
	board.on('ready', () => stdout({ type: 'ready' }));
	// When board is found but no Firmata is flashed
	board.on('error', error => stdout({ type: 'error', message: error.message }));
	// This event is emitted synchronously on SIGINT.
	// Use this handler to do any necessary cleanup before your program is "disconnected" from the board.
	board.on('exit', () => stdout({ type: 'exit' }));
	// This event is emmited when the device does not respond.
	// Can be used to detect if board gets disconnected.
	board.on('close', () => stdout({ type: 'close' }));
	// This event will emit once the program has "connected" to the board.
	// This may be immediate, or after some amount of time, but is always asynchronous.
	// For on-board execution, connect should emit as soon as possible, but asynchronously.
	board.on('connect', () => stdout({ type: 'connect' }));
	// This event will emit for any logging message: info, warn or fail.
	board.on('message', stdout);
} catch (error) {
	stdout({ type: 'error', message: 'catching error', ...error });
}

/**
 * @typedef {Object} SetExternalMessage
 * @property {'setExternal'} type
 * @property {string} nodeId
 * @property {unknown} value
 */

/**
 * @typedef {Object} FlowChangeMessage
 * @property {'flow'} type
 * @property {Node[]} nodes
 * @property {Edge[]} edges
 */

/**
 * @typedef {SetExternalMessage | FlowChangeMessage} WorkerMessage
 */

process.on('message', (/** @type {WorkerMessage} */ message) => {
	console.log('message', message);
	switch (message.type) {
		case 'setExternal':
			const node = nodes.get(message.nodeId);
			node?.setExternal?.(message.value);
			break;
		case 'flow':
			// Step 1; remove handlers for edges that are no longer connected
			const newEdgesIds = message.edges.map(({ id }) => id);
			Array.from(unsubscribers.keys())
				.filter(edgeId => !newEdgesIds.includes(edgeId))
				.forEach(edgeId => {
					const unsubscribe = unsubscribers.get(edgeId);
					unsubscribe?.();
					unsubscribers.delete(edgeId);
				});

			// Step 2; remove nodes that no longer exist
			const currentNodesIds = Array.from(nodes.keys());
			const newNodesIds = message.nodes.map(({ id }) => id);
			currentNodesIds.filter(nodeId => !newNodesIds.includes(nodeId)).forEach(nodes.delete);

			// Step 3; set the data of the current nodes
			currentNodesIds.forEach(nodeId => {
				const currentNode = nodes.get(nodeId);
				if (!currentNode) return;
				const newNode = message.nodes.find(({ id }) => id === nodeId);
				if (!newNode) return;
				currentNode.data = newNode.data;
			});

			// Step 3; add new nodes
			message.nodes
				.filter(({ id }) => !currentNodesIds.includes(id))
				.forEach(node => {
					const nodeInstance = new MicroflowComponents[node.type](node.data);
					nodes.set(node.id, nodeInstance);
				});

			// Step 4; add new handlers for edges that are now connected
			newEdgesIds.forEach(edgeId => {
				const edge = message.edges.find(({ id }) => id === edgeId);
				if (!edge) return;
				const sourceNode = nodes.get(edge.source);
				if (!sourceNode) return;
				const targetNode = nodes.get(edge.target);
				if (!targetNode) return;
				const unsubscribe = sourceNode.on(edge.sourceHandle, value => {
					try {
						const targetType = targetNode.data.type;
						switch (targetType) {
							case 'gate':
							case 'calculate':
								targetNode.check(value);
								break;
							case 'llm':
								if (edge.targetHandle === 'invoke') {
									targetNode.invoke();
									break;
								}
								targetNode.setVariable(edge.targetHandle, value);
								break;
							default:
								targetNode[edge.targetHandle](value);
								break;
						}
					} catch (error) {
						console.error(error);
					}
				});

				unsubscribers.set(edgeId, unsubscribe);
			});
			break;
		default:
			stdout({
				type: 'error',
				message: 'Unknown message type',
				...message,
			});
			break;
	}
});
