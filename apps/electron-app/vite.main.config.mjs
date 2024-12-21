import copy from 'rollup-plugin-copy';
import { defineConfig } from 'vite';

const dest = '.vite/build';

// https://vitejs.dev/config
export default defineConfig({
	build: {
		rollupOptions: {
			external: ['serialport'],
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
});
