import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const projectRootDir = path.resolve(__dirname);

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
	plugins: [react(), viteSingleFile()],
	root: path.resolve('src/ui'),
	build: {
		minify: mode === 'production',
		cssMinify: mode === 'production',
		sourcemap: mode !== 'production' ? 'inline' : false,
		emptyOutDir: false,
		outDir: path.resolve('dist'),
		rollupOptions: {
			input: path.resolve('src/ui/index.html'),
		},
	},
	resolve: {
		alias: {
			'@ui': path.resolve(projectRootDir, '../../packages/ui'),
		},
	},
}));
