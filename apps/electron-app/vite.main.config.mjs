import copy from 'rollup-plugin-copy';
import { defineConfig } from 'vite';

const dest = '.vite/build';

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
				{ src: 'workers', dest },
				{ src: 'hex', dest },
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
