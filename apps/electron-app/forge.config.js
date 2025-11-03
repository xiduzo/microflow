const { bundle } = require('./bundler');
const path = require('path');
require('dotenv').config();
const fs = require('fs/promises');
const packageJson = require('./package.json');

const isCI = !!process.env.GITHUB_ACTIONS;

const packageVersion = packageJson.version;
// Extract major.minor version without patch
const shortVersion = packageVersion.split('.').slice(0, 2).join('.');

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
	packagerConfig: {
		appCategoryType: 'public.app-category.developer-tools',
		appBundleId: 'nl.sanderboer.microflow-studio',
		appCopyright: `Copyright © ${new Date().getFullYear()} Xiduzo`,
		appVersion: `${packageVersion}`,
		buildVersion: `${shortVersion}.${process.env.GITHUB_RUN_ID || '0'}`,
		// name: 'microflow-studio', // Should not have spaces or special characters (else MacOS can not build because of folder name)
		executableName: 'Microflow studio',
		icon: path.resolve(__dirname, 'assets', 'icon'),
		prune: false, // required for monorepo
		protocols: [
			{
				name: 'microflow-studio',
				schemes: ['microflow-studio'],
			},
		],
		osxSign:
			isCI || true
				? {
						// identity: process.env.APPLE_IDENTITY,
					}
				: undefined,
		osxNotarize:
			isCI || true
				? {
						tool: 'notarytool',
						appleId: process.env.APPLE_ID,
						appleIdPassword: process.env.APPLE_ID_PASSWORD,
						teamId: process.env.APPLE_TEAM_ID,
					}
				: undefined,
	},
	hooks: {
		packageAfterCopy: (_forgeConfig, buildPath) => bundle(__dirname, buildPath),
	},

	rebuildConfig: {
		disablePreGypCopy: true,
	},

	// https://www.electronforge.io/config/makers
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
				options: {
					maintainer: 'Sander Boer <mail@sanderboer.nl>',
					homepage: 'https://sanderboer.nl',
				},
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
