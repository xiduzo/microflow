import copy from 'rollup-plugin-copy';
import { defineConfig } from 'vite';

const root = '.vite';
const build = `${root}/build`;

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
});
