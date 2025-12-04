import alias from '@rollup/plugin-alias';
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRootDir = path.resolve(__dirname);

// Create empty stub modules for Node.js-only packages
const emptyModulePath = path.resolve(projectRootDir, 'src/common/empty-module.ts');

// https://vitejs.dev/config
export default defineConfig({
	plugins: [react(), alias()],
	resolve: {
		alias: {
			'@ui': path.resolve(projectRootDir, '../../packages/ui'),
			'johnny-five': emptyModulePath,
			'node-pixel': emptyModulePath,
		},
	},
	define: {
		'process.env': '{}',
		'process.platform': JSON.stringify('browser'),
		'process.version': JSON.stringify('v16.0.0'),
		'process.browser': 'true',
		global: 'globalThis',
	},
	optimizeDeps: {
		exclude: ['johnny-five', 'node-pixel'],
	},
});
