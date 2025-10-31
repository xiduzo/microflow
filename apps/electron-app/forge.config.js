const { bundle } = require('./bundler');
const path = require('path');
require('dotenv').config();

const isCI = !!process.env.GITHUB_ACTIONS;

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
	packagerConfig: {
		name: 'Microflow studio',
		executableName: 'Microflow studio',
		icon: 'assets/icon',
		prune: false, // required for monorepo
		appBundleId: 'nl.sanderboer.microflow-studio', // or your actual bundle ID

		protocols: [
			{
				name: 'microflow-studio',
				schemes: ['microflow-studio'],
			},
		],

		osxSign: isCI
			? {
					identity: process.env.APPLE_IDENTITY,
					strictVerify: false,
				}
			: undefined,
		osxNotarize: isCI
			? {
					appleId: process.env.APPLE_ID,
					appleIdPassword: process.env.APPLE_PASSWORD,
					teamId: process.env.APPLE_TEAM_ID,
				}
			: undefined,
	},
	hooks: {
		packageAfterCopy: async (_forgeConfig, buildPath) => {
			await bundle(__dirname, buildPath);
		},
	},

	rebuildConfig: {
		disablePreGypCopy: true,
	},

	makers: [
		{ name: '@electron-forge/maker-squirrel' }, // Windows
		{
			name: '@electron-forge/maker-dmg',
			config: { format: 'ULFO' },
		},
		{ name: '@electron-forge/maker-zip', platforms: ['darwin'] },
		{
			name: '@electron-forge/maker-deb',
			config: {
				bin: 'Microflow studio',
				mimeType: ['x-scheme-handler/mfs', 'x-scheme-handler/microflow-studio'],
			},
		},
		{
			name: '@electron-forge/maker-rpm',
			config: {
				bin: 'Microflow studio',
				mimeType: ['x-scheme-handler/mfs', 'x-scheme-handler/microflow-studio'],
			},
		},
	],

	buildIdentifier: 'microflow-studio',

	plugins: [
		{
			name: '@electron-forge/plugin-vite',
			config: {
				build: [
					{
						entry: 'src/main.js',
						config: 'vite.main.config.mjs',
					},
					{
						entry: 'src/preload.ts',
						config: 'vite.preload.config.mjs',
					},
				],
				renderer: [
					{
						name: 'main_window',
						config: 'vite.renderer.config.mjs',
					},
				],
			},
		},
	],

	publishers: [
		{
			name: '@electron-forge/publisher-github',
			config: {
				repository: {
					owner: 'xiduzo',
					name: 'microflow',
				},
				prerelease: true,
			},
		},
	],
};
