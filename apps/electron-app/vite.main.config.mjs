import copy from 'rollup-plugin-copy';
import { defineConfig } from 'vite';
import path from 'path';

const root = '.vite';
const build = `${root}/build`;
const projectRootDir = path.resolve(__dirname);

// https://vitejs.dev/config
export default defineConfig({
	build: {
		rollupOptions: {
			external: ['serialport', 'bufferutil', 'utf-8-validate'],
		},
	},
	plugins: [
		copy({
			targets: [
				{ src: 'workers', dest: build },
				{ src: '../../packages/flasher/hex', dest: build },
			],
			// hook: 'buildEnd',
		}),
	],
	resolve: {
		// Some libs that can run in both Web and Node.js, such as `axios`, we need to tell Vite to build them in Node.js.
		browserField: false,
		conditions: ['node'],
		mainFields: ['module', 'jsnext:main', 'jsnext'],
	},
	optimizeDeps: {
		// Exclude workspace packages from optimization so changes are picked up immediately
		exclude: [
			'@microflow/flasher',
			'@microflow/runtime',
			'@microflow/ui',
			'@microflow/utils',
			'@microflow/mqtt-provider',
		],
	},
	server: {
		watch: {
			// Watch package source directories for changes
			ignored: ['**/node_modules/**', '**/.git/**'],
		},
	},
});
