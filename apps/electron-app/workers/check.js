const Components = require('@microflow/components');
const { Edge, Node, NodeChange, EdgeChange } = require('@xyflow/react');
const { isNodeBase, isEdgeBase } = require('@xyflow/system');

const port = process?.argv?.at(-1);

if (!port) {
	console.info(
		JSON.stringify({
			type: 'info',
			message:
				'No port provided, johnny five usualy can handle this. This might cause unforseen behavior.',
		}),
	);
}

function stdout(data) {
	process.send(data);
}

try {
	const ipRegex = new RegExp(
		/^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/,
	);
	let connection;

	if (ipRegex.test(port)) {
		connection = new TcpSerial({ host: port, port: 3030 });

		connection.on('close', () =>
			stdout({
				type: 'close',
				message: `Connection not reachable on ${port}`,
				class: TcpSerial.name,
			}),
		);
	}

	const board = new Components.Board({
		repl: false,
		debug: true,
		port: connection || port,
	});

	// This event will emit after the connect event and only when the Board instance object has completed
	// any hardware initialization that must take place before the program can operate.
	// This process is asynchronous, and completion is signified to the program via a "ready" event
	// For on-board execution, ready should emit after connect.
	board.on('ready', () =>
		stdout({
			type: 'ready',
			pins: Object.entries(board.pins).reduce((acc, [key, value]) => {
				acc.push({ pin: Number(key), ...value });
				return acc;
			}, []),
		}),
	);
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
 * Map of node IDs to their corresponding components.
 * @type {Map<string, keyof typeof Components>}
 */
const components = new Map();

/**
 * Map of actions between nodes.
 * @type {Map<string, Map<string, function>>}
 */
const actions = new Map();

process.on('message', message => {
	switch (message.type) {
		case 'init':
			/**
			 * @type {{ nodes: Node[], edges: Edge[] }}
			 */
			const { nodes, edges } = message.data;
			nodes.forEach(addNode);
			edges.forEach(addAction);
			break;
		case 'change':
			/**
			 * @type {{ change?: NodeChange | EdgeChange }}
			 */
			const { change } = message.data;
			stdout({ type: 'info', message: `received change`, message });

			switch (change.type) {
				case 'remove':
					if (isNodeBase(change)) removeNode(change);
					if (isEdgeBase(change)) removeAction(change);
					break;
				case 'add':
				case 'replace':
					if (isNodeBase(change)) addNode(change);
					if (isEdgeBase(change)) addAction(change);
					break;
			}
			break;
		default:
			stdout({ type: 'error', message: `Unknown message type: ${message.type}` });
			break;
	}
});

/**
 * Adds a subscription to a node's component.
 * @param {Node} node - The node to subscribe to.
 * @param {typeof Components} component - The component instance of the node.
 */
function addSubscription(node, component) {
	component.subscribe(args => {
		const { handle, value } = args;
		const handleListeners = actions.get(`${node.id}_${handle}`);
		if (!handleListeners) return; // skip if no actions for this handle
		Object.entries(handleListeners).forEach(([listener, callback]) => {
			if (typeof callback !== 'function') return;

			const [targetId, targetHandle] = listener.split('_');

			try {
				const targetComponent = components.get(targetId);
				if (!targetComponent) return; // Node must have been removed
				const targetComponentName = targetComponent.constructor.name;

				// Could be moved out of the loop, but this is more readable
				const componentsThatRequireAllInputs = [Components['Gate'], Components['Calculate']].map(
					({ constructor }) => constructor.name,
				);

				// If the target node requires all inputs, we need to ensure all inputs are provided
				if (componentsThatRequireAllInputs.includes(targetComponentName)) {
					callback(getNodeValues(getInputHandleIds(targetId)));
					return;
				}

				// Handle the dynamic variable setting for LLM components
				if (
					targetComponentName === Components['Llm'].constructor.name &&
					targetHandle !== Components['Llm'].prototype.invoke.name
				) {
					targetComponent[Components['Llm'].prototype.setVariable.name](targetHandle, value);
					return;
				}

				callback(value);
			} catch (error) {
				stdout(`Error executing ${node.id}->${handle}->${targetId}->${targetHandle}`, error);
			}
		});
	});
}

/**
 * Adds an action to the actions map for a given edge.
 * @param {Edge} edge - The edge containing source and target information.
 */
function addAction(edge) {
	const target = components.get(edge.target);
	if (!target) return; // skip if target node does not exist
	const sourceHandles = actions.get(`${edge.source}_${edge.sourceHandle}`) ?? new Map();
	sourceHandles.set(`${edge.target}_${edge.targetHandle}`, target[edge.targetHandle]);
}

/**
 * Removes an action from the actions map for a given edge.
 * @param {Edge} edge - The edge containing source and target information.
 */
function removeAction(edge) {
	const sourceHandles = actions.get(`${edge.source}_${edge.sourceHandle}`);
	sourceHandles?.delete(`${edge.target}_${edge.targetHandle}`);
}

/**
 * Adds a node to the components map and sets up its subscription.
 * @param {Node} node
 */
function addNode(node) {
	try {
		const component = new Components[node.data.baseType ?? node.type](node.data);
		addSubscription(node, component);
		// TODO initial trigger -- can be separate component?
		components.set(node.id, component);
	} catch (error) {
		stdout({ type: 'error', message: `Error creating component for node ${node.id}`, node, error });
	}
}

/**
 * Removes a node from the components map and its actions.
 * @param {Node} node
 */
function removeNode(node) {
	const component = components.get(node.id);
	component?.unsubscribe();
	components.delete(node.id);
	actions.forEach((actionMap, key) => {
		if (key.startsWith(node.id)) {
			actions.delete(key);
			return;
		}

		actionMap.forEach((_, actionKey) => {
			if (actionKey.startsWith(node.id)) actionMap.delete(actionKey);
		});
	});
}

/**
 * Retrieves the values of nodes by their IDs.
 * @param {string[]} handleIds - Array of node IDs.
 */
function getNodeValues(handleIds) {
	return handleIds.reduce((acc, id) => {
		const component = components.get(id);
		if (component && 'value' in component) {
			const { value } = component;
			const name = component.constructor.name;

			if (name === Components['RangeMap'].constructor.name) value = value.at(0);
			acc.push(value);
		}
		return acc;
	}, []);
}

/**
 *
 * @param {string} targetId
 * @returns {string[]} - Array of source IDs that have actions targeting the given targetId.
 */
function getInputHandleIds(targetId) {
	return Object.entries(actions).reduce((acc, curr) => {
		const [source, actionMap] = curr;
		const [sourceId] = source.split('_');
		const includesTargetInActions = Array.from(actionMap.keys()).some(key =>
			key.startsWith(targetId),
		);
		if (includesTargetInActions) acc.push(sourceId);
		return acc;
	}, []);
}
