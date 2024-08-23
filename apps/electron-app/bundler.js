// based on https://github.com/electron-userland/electron-forge/issues/2306#issuecomment-1034882039
'use strict';

/**
 * @typedef {{
 *   new (options: { path: string }): {
 *     loadActual(): Promise<Node>
 *   }
 * }} Arborist
 */

const fs = require('fs/promises');
const path = require('path');

/** @type {Arborist} */
// @ts-ignore missing types for @npmcli/arborist
const arborist = require('@npmcli/arborist');
const { findRoot } = require('@manypkg/find-root');

/**
 * @typedef {{
 *  workspace: boolean;
 *  type: 'prod' | 'dev' | 'peer' | 'optional'
 *  to: Node;
 * }} Edge
 */

/**
 * @typedef {{
 *  isLink: boolean;
 *  location: string;
 *  realpath: string;
 *  target: Node;
 *  name: string;
 *  version: string;
 *  edgesOut: Map<string, Edge>;
 * }} Node
 */

/** @type {(node: Node) => Node} */
const resolveLink = node => (node.isLink ? resolveLink(node.target) : node);

/** @type {(node: Node, realPath: string) => Node | undefined} */
const getWorkspaceByPath = (node, realPath) =>
	[...node.edgesOut.values()]
		.filter(depEdge => depEdge.workspace)
		.map(depEdge => resolveLink(depEdge.to))
		.find(depNode => depNode.realpath === realPath);

/** @type {(node: Node) => Node[]} */
const collectProdDeps = node => {
	const stack = [node];
	/** @type {Map<string, Node>} */
	const result = new Map(); // Using a set to avoid duplicates and track visited nodes

	while (stack.length > 0) {
		const currentNode = stack.pop();
		// Ignore types packages
		if (currentNode.location.startsWith('node_modules/@types')) {
			// console.debug(`IGNORE ${currentNode.location}`);
			continue;
		}

		// Ignore radix-ui packages
		if (currentNode.location.includes('@radix-ui')) {
			// console.debug(`IGNORE ${currentNode.location}`);
			continue;
		}

		const depEdges = [...currentNode.edgesOut.values()]
			.filter(depEdge => depEdge.type === 'prod')
			.filter(
				depEdge => !depEdge.to.location.startsWith('node_modules/@types'),
			);

		// Show dependencies
		// console.debug(
		// 	currentNode.location,
		// 	depEdges.map(depEdge => depEdge.to.location),
		// );

		for (const depEdge of depEdges) {
			const depNode = resolveLink(depEdge.to);

			const addedNode = result.get(depNode.name);
			if (addedNode) {
				const addedVersion = Number(addedNode.version.replace(/[.]/g, ''));
				const depVersion = Number(depNode.version.replace(/[.]/g, ''));

				if (depVersion > addedVersion) {
					console.log(
						'newer version detected',
						'from',
						addedNode.name,
						addedNode.location,
						addedVersion,
						'to',
						depNode.name,
						depNode.location,
						depVersion,
					);

					stack.push(depNode);
				}
			} else {
				stack.push(depNode);
			}

			console.log('adding module', depNode.name, depNode.version);
			result.set(depNode.name, depNode);
		}
	}

	return Array.from(result.values()); // Convert the set to an array if necessary
};

/** @type {(source: string, destination: string) => Promise<void>} */
const bundle = async (source, destination) => {
	const root = await findRoot(source);
	const rootNode = await new arborist({ path: root.rootDir }).loadActual();
	const sourceNode = getWorkspaceByPath(rootNode, source);

	if (!sourceNode) {
		throw new Error("couldn't find source node");
	}

	const prodDeps = collectProdDeps(sourceNode);

	for (const dep of prodDeps) {
		const dest = dep.location.startsWith('packages')
			? path.join(destination, 'node_modules', '@microflow', dep.name)
			: path.join(destination, 'node_modules', dep.name);

		if (dep.name.startsWith('@types')) {
			// console.debug(`IGNORE ${dep.name}`);
			continue;
		}

		// console.log(dep.name, `${dep.location} --> ${dest}`);

		await fs.cp(dep.realpath, dest, {
			recursive: true,
			errorOnExist: false,
			dereference: true,
			filter: source => {
				console.log('>> copying', source);
				return true;
			},
		});

		// if (dest.includes('@serialport/bindings-cpp')) {
		// 	// Check if folder exists
		// 	const folder = path.join(dest, 'build', 'node_gyp_bins');
		// 	const exists = await fs.readdir(folder).catch(() => false);
		// 	console.log('!!!! patching serialport', dest, exists);
		// }
	}
};

module.exports = { bundle };
