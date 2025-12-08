import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
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
