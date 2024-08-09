import alias from '@rollup/plugin-alias';
import path from 'path';
import { defineConfig } from 'vite';

const projectRootDir = path.resolve(__dirname);

// https://vitejs.dev/config
export default defineConfig({
	plugins: [alias()],
	resolve: {
		alias: {
			'@ui': path.resolve(projectRootDir, '../../packages/ui'),
		},
	},
});
