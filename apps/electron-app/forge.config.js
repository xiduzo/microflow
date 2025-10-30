const { bundle } = require('./bundler');
require('dotenv').config();
const fs = require('fs/promises');

/**
 * Microflow studio.app: code has no resources but signature indicates they must be present
 *
 * > This error message also occurs when your certificate is expired. It took me a minute to realize why my build machine was broken without any code change.
 * via https://github.com/electron/forge/issues/3131#issuecomment-2343863375
 */

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
	// forge.config.js (replace the packagerConfig block)
	packagerConfig: {
		name: 'Microflow studio',
		executableName: 'Microflow-studio', // avoid spaces in actual executable
		icon: 'assets/icon',
		// Exclude unwanted folders at packaging time (before signing)
		ignore: filePath => {
			// Skip any node_gyp bins or similar artifacts
			if (filePath.includes('build/node_gyp_bins')) {
				return true;
			}
			return false;
		},
		osxSign: {
			strictVerify: false,
			identity: process.env.APPLE_IDENTITY,
			entitlements: 'entitlements.plist',
			// prevent pre-embed step from running when no profile is present
			'pre-embed-provisioning-profile': false,
			// optional but good practice if you have one
			// 'provisioning-profile': 'microflow.provisionprofile',
		},
		osxNotarize: {
			appleId: process.env.APPLE_ID,
			appleIdPassword: process.env.APPLE_PASSWORD,
			teamId: process.env.APPLE_TEAM_ID,
		},
		// optional; recommended for macOS apps
		appBundleId: 'nl.sanderboer.microflow-studio',
		prune: false,
		protocols: [
			{
				name: 'microflow-studio',
				schemes: ['microflow-studio'],
			},
		],
	},
	hooks: {
		packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, _platform, _arch) => {
			// https://gist.github.com/robin-hartmann/ad6ffc19091c9e661542fbf178647047
			// this is a workaround until we find a proper solution
			// for running electron-forge in a mono repository
			await bundle(__dirname, buildPath);
		},
	},
	rebuildConfig: {
		disablePreGypCopy: true,
	},
	makers: [
		{
			name: '@electron-forge/maker-squirrel', // Windows
			config: {},
		},
		{
			name: '@electron-forge/maker-dmg', // MacOS
			config: {
				format: 'ULFO',
			},
		},
		{
			name: '@electron-forge/maker-zip',
			platforms: ['darwin'],
		},
		{
			name: '@electron-forge/maker-deb', // Debian, Ubuntu, etc.
			config: {
				bin: 'Microflow studio',
				mimeType: ['x-scheme-handler/mfs', 'x-scheme-handler/microflow-studio'],
			},
		},
		{
			name: '@electron-forge/maker-rpm', // Fedora, Red Hat, etc.
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
				// `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
				// If you are familiar with Vite configuration, it will look really familiar.
				build: [
					{
						// `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
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
