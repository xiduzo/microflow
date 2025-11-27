const MicroflowComponents = require('@microflow/runtime');
const { Board, TcpSerial } = require('@microflow/runtime');
const { Edge, Node } = require('@xyflow/react');

const port = process?.argv?.at(-1);

if (!port) {
	console.warn(
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
 * @typedef {InstanceType<typeof MicroflowComponents[keyof typeof MicroflowComponents]>} ComponentInstance
 */
/**
 * Map of component instances by node ID.
 * @type {Map<string, ComponentInstance>}
 */
const components = new Map();

/**
 * Map of event unsubscribers by edge ID.
 * @type {Map<string, Function>}
 */
const unsubscribers = new Map();

/**
 * Board instance
 * @type {Board | null}
 */
let boardInstance = null;

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

	boardInstance = new Board({
		repl: false,
		debug: true,
		port: connection || port,
	});

	// This event will emit after the connect event and only when the Board instance object has completed
	// any hardware initialization that must take place before the program can operate.
	// This process is asynchronous, and completion is signified to the program via a "ready" event
	// For on-board execution, ready should emit after connect.
	boardInstance.on('ready', () => stdout({ type: 'ready', pins: getPins(boardInstance) }));
	// When board is found but no Firmata is flashed
	boardInstance.on('error', error => stdout({ type: 'error', message: error.message }));
	// This event is emitted synchronously on SIGINT.
	// Use this handler to do any necessary cleanup before your program is "disconnected" from the board.
	boardInstance.on('exit', () => stdout({ type: 'exit' }));
	// This event is emmited when the device does not respond.
	// Can be used to detect if board gets disconnected.
	boardInstance.on('close', () => stdout({ type: 'close' }));
	// This event will emit once the program has "connected" to the board.
	// This may be immediate, or after some amount of time, but is always asynchronous.
	// For on-board execution, connect should emit as soon as possible, but asynchronously.
	boardInstance.on('connect', () => stdout({ type: 'connect' }));
	// This event will emit for any logging message: info, warn or fail.
	boardInstance.on('message', stdout);
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
	switch (message.type) {
		case 'setExternal':
			const node = components.get(message.nodeId);
			node?.setExternal?.(message.value);
			break;
		case 'flow':
			// TODO: this can be optimized to only handle changes

			boardInstance.io.removeAllListeners();
			boardInstance.register = []; // Remove references to old components

			// Step 1; remove compoments
			Array.from(components.entries()).forEach(([nodeId, nodeInstance]) => {
				nodeInstance.destroy();
				components.delete(nodeId);
			});

			// Step 2; add new components
			message.nodes.forEach(node => {
				try {
					const instance = node.data.instance;
					const nodeInstance = new MicroflowComponents[instance]({
						...node.data,
						id: node.id,
						board: boardInstance,
					});
					components.set(node.id, nodeInstance);
				} catch (error) {
					stdout({
						type: 'error',
						message: `Error creating component ${node.data.instance}`,
						...error,
						node: node,
					});
				}
			});

			// Step 3; add handlers
			message.edges.forEach(edge => {
				const sourceNode = components.get(edge.source);
				if (!sourceNode) return;
				const targetNode = components.get(edge.target);
				if (!targetNode) return;
				const eventHandler = handler(sourceNode, targetNode, edge, message.edges);
				sourceNode.on(edge.sourceHandle, eventHandler);
				// unsubscribers.set(edge.id, () => sourceNode.off(edge.sourceHandle, eventHandler));
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

function getPins(board) {
	return Object.entries(board.pins).reduce((acc, [key, value]) => {
		acc.push({ pin: Number(key), ...value });
		return acc;
	}, []);
}

/**
 *
 * @param {ComponentInstance} sourceNode
 * @param {ComponentInstance} targetNode
 * @param {Edge} edge
 * @param {Edge[]} edges
 * @returns {Function}
 */
const handler = (sourceNode, targetNode, edge, edges) => value => {
	try {
		const targetType = targetNode.data.instance.toLowerCase();
		switch (targetType) {
			case 'gate':
			case 'calculate':
				targetNode.check(getInputValues(targetNode, edges));
				break;
			case 'llm':
				if (edge.targetHandle !== 'invoke') break;
				targetNode.invoke(getInputValueAsKeyValuePairs(targetNode, edges));
				break;
			default:
				targetNode[edge.targetHandle](value);
				break;
		}
		sourceNode.postMessage(edge.sourceHandle, edge.id);
	} catch (error) {
		console.error(error);
	}
};

/**
 *
 * @param {ComponentInstance} targetNode
 * @param {Edge[]} edges
 * @returns {unknown[]}
 */
function getInputValues(targetNode, edges) {
	return edges
		.filter(({ target }) => target === targetNode.id)
		.map(({ source }) => components.get(source)?.value);
}

function getInputValueAsKeyValuePairs(targetNode, edges) {
	return edges
		.filter(({ target }) => target === targetNode.id)
		.reduce((acc, { targetHandle, source }) => {
			if (acc[targetHandle]) {
				acc[targetHandle] = [acc[targetHandle], components.get(source)?.value].join(', ');
			} else {
				acc[targetHandle] = components.get(source)?.value;
			}
			return acc;
		}, {});
}
