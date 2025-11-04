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
const collectProdDeps = node =>
	[...node.edgesOut.values()]
		.filter(depEdge => depEdge.type === 'prod')
		.map(depEdge => resolveLink(depEdge.to))
		.flatMap(depNode => [depNode, ...collectProdDeps(depNode)]);

/** @type {(current: number, total: number, width?: number) => string} */
const createProgressBar = (current, total, width = 20) => {
	const percentage = total > 0 ? current / total : 0;
	const filled = Math.round(width * percentage);
	const empty = width - filled;
	return `[${'x'.repeat(filled)}${'-'.repeat(empty)}] ${current}/${total}`;
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

	let index = 0;

	console.log(`Copying ${prodDeps.length} dependencies to ${destination}`);
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
				// console.log('>> copying', source);
				return true;
			},
		});

		index++;
		// Update progress bar on the same line
		process.stdout.write(`\r${createProgressBar(index, prodDeps.length)}\x1b[K`);

		// if (dest.includes('@serialport/bindings-cpp')) {
		// 	// Check if folder exists
		// 	const folder = path.join(dest, 'build', 'node_gyp_bins');
		// 	const exists = await fs.readdir(folder).catch(() => false);
		// 	console.log('!!!! patching serialport', dest, exists);
		// }
	}

	// Add newline at the end when complete
	console.log('');
};

module.exports = { bundle };
