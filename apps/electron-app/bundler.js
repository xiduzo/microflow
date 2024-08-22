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
	const result = new Set(); // Using a set to avoid duplicates and track visited nodes

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

		const depEdges = [...currentNode.edgesOut.values()].filter(
			depEdge => depEdge.type === 'prod',
		);

		// Show dependencies
		// console.debug(
		// 	currentNode.location,
		// 	depEdges.map(depEdge => depEdge.to.location),
		// );

		for (const depEdge of depEdges) {
			const depNode = resolveLink(depEdge.to);

			if (!result.has(depNode)) {
				result.add(depNode);
				stack.push(depNode);
			}
		}
	}

	return Array.from(result); // Convert the set to an array if necessary
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
		const dest = path.join(destination, dep.location);

		let bundlePath = dest;
		if (dep.location.startsWith('packages')) {
			switch (dep.location) {
				case 'packages/components':
					bundlePath = dest.replace('packages', 'node_modules/@microflow');
					break;
				default:
					continue;
			}
		}

		console.log(`${dep.location} --> ${bundlePath}`);

		await fs.cp(dep.realpath, bundlePath, {
			recursive: true,
			errorOnExist: false,
		});
	}
};

module.exports = { bundle };
