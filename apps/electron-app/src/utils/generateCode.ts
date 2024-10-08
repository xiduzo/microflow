import { Edge, Node } from '@xyflow/react';

export function isNodeTypeACodeType(type: string) {
	return !['note'].includes(type.toLowerCase());
}

export function generateCode(nodes: Node[], edges: Edge[]) {
	let code = `
/*
 * This code was generated by Microflow studio.
 *
 * No warranty is provided.
 */
`;

	code += addImports();

	code += addEnter();
	code += `
const port = process.argv.at(-1);

if (!port) {
	log.warn(
		'No port provided, johnny five usualy can handle this. This might cause unforseen behavior.',
	);
}
`;

	code += addEnter();
	code += `const nodes = new Map();`;
	code += addEnter();

	let innerCode = ``;

	innerCode += addBoard();

	const boardListeners = ['error', 'fail', 'warn', 'exit', 'close', 'info'];
	boardListeners.forEach(listener => {
		innerCode += addBoardListener(listener);
	});

	innerCode += addBoardListener('ready', false);

	nodes.forEach(node => {
		node.data.id = node.id; // Expose the Id to the options
		innerCode += `  const ${node.type}_${node.id} = new MicroflowComponents.${node.type}(${JSON.stringify(node.data)});`;
		innerCode += addEnter();
		innerCode += `  nodes.set("${node.id}", ${node.type}_${node.id});`;
		innerCode += addEnter();
	});

	innerCode += addEnter();
	innerCode += addEnter();

	const nodesWithActionListener = nodes.filter(node => edges.some(edge => edge.source === node.id));

	nodesWithActionListener.forEach(node => {
		const actions = edges.filter(edge => edge.source === node.id);

		const actionsGroupedByHandle = actions.reduce(
			(acc, action) => ({
				...acc,
				[action.sourceHandle]: [...(acc[action.sourceHandle] || []), action],
			}),
			{} as Record<string, Edge[]>,
		);

		Object.entries(actionsGroupedByHandle).forEach(([action, edges]) => {
			innerCode += `  ${node.type}_${node.id}.on("${action}", () => {`;
			innerCode += addEnter();

			edges.forEach(edge => {
				const targetNode = nodes.find(node => node.id === edge.target);
				// TODO: maybe be a bit more specific about the value and also include the type?
				const valueTriggers = [
					'set',
					'check',
					'red',
					'green',
					'blue',
					'opacity',
					'from',
					'publish',
					'rotate',
					'to',
					'show',
				];

				const shouldSetValue = valueTriggers.includes(edge.targetHandle);
				let value = shouldSetValue ? `${node.type}_${node.id}.value` : undefined;

				if (node.type === 'RangeMap' && shouldSetValue) {
					// Mapper node
					innerCode += addEnter();
					value = `${node.type}_${node.id}.value[1]`;
				}

				// TODO: add support for increment and decrement bigger than 1
				// TODO: add support for multiple values
				innerCode += `    ${targetNode?.type}_${targetNode?.id}.${edge.targetHandle}(${value});`;
				innerCode += addEnter();
			});

			innerCode += `  }); // ${node.type}_${node.id} - ${action}`;
			innerCode += addEnter();
			innerCode += addEnter();
		});
	});

	innerCode += `}); // board - ready`;

	code += wrapInTryCatch(innerCode);

	code += addNodeProcessListener();

	return code;
}

function addEnter() {
	return `
`;
}

function addImports() {
	return `
const MicroflowComponents = require("@microflow/components");
const log = require("electron-log/node");
`;
}

function addBoard() {
	return `
const board = new MicroflowComponents.Board({
  repl: false,
  debug: false,
  port: port,
});

log.info("Board is created", { port: board.port });
`;
}

function addBoardListener(type: string, selfClosing = true) {
	const pins =
		type === 'ready'
			? `, pins: Object.entries(board.pins).reduce((acc, [key, value]) => {
    acc.push({ pin: Number(key), ...value, });
    return acc;
  }, [])
  `
			: ``;
	return `
board.on("${type}", (event) => {
  log.info("board ${type}", { event });
  process.parentPort.postMessage({ type: "${type}", message: event?.message${pins} });
${selfClosing ? `}); // board - ${type}` : ``}
`;
}

function addNodeProcessListener() {
	let code = `
// Listen to events from electron
process.parentPort.on('message', (e) => {`;

	let innerCode = ``;

	innerCode += 'const node = nodes.get(e.data.nodeId);';
	innerCode += addEnter();
	innerCode += 'node?.setExternal?.(e.data.value);';

	code += wrapInTryCatch(innerCode);

	code += `
}); // process.parentPort.on - 'message'`;
	return code;
}

function wrapInTryCatch(code: string) {
	return `
try {
  ${code}
} catch(error) {
  log.error("something went wrong", { error });
}`;
}
