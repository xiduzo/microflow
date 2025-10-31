const { bundle } = require('./bundler');
require('dotenv').config();

const isCI = !!process.env.GITHUB_ACTIONS;

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
	packagerConfig: {
		name: 'Microflow studio',
		executableName: 'Microflow studio',
		icon: 'assets/icon',
		prune: false, // required for monorepo

		protocols: [
			{
				name: 'microflow-studio',
				schemes: ['microflow-studio'],
			},
		],

		osxSign: {
			identity: process.env.APPLE_IDENTITY,
			hardenedRuntime: true,
			entitlements: 'entitlements.plist',
			'entitlements-inherit': 'entitlements.plist',
			'signature-flags': 'library',
			'gatekeeper-assess': false,
			strict: false, // <-- Key fix for "no resources" error
		},

		// Only notarize in CI to speed up local dev
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
