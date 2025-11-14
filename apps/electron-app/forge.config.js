const { bundle } = require('./bundler');
const path = require('path');
require('dotenv').config();
const fs = require('fs/promises');
const packageJson = require('./package.json');

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
		name: 'Microflow studio',
		executableName: 'Microflow studio',
		icon: path.resolve(__dirname, 'assets', 'icon'),
		prune: false, // required for monorepo
		// asar: true,
		protocols: [
			{
				name: 'microflow-studio',
				schemes: ['microflow-studio'],
			},
		],
		osxSign: {
			identity: process.env.APPLE_DEVELOPER_ID_APPLICATION,
			preEmbedProvisioningProfile: false,
			// provisioningProfile: 'microflow-studio.provisionprofile',
		},
		osxNotarize: {
			tool: 'notarytool',
			appleId: process.env.APPLE_ID,
			appleIdPassword: process.env.APPLE_ID_PASSWORD,
			teamId: process.env.APPLE_TEAM_ID,
		},
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
			config: {
				format: 'ULFO',
				background: path.resolve(__dirname, 'assets', 'dmg-background.png'),
				contents: options => [
					{
						x: 145,
						y: 325,
						type: 'file',
						path: options.appPath,
					},
					{
						x: 485,
						y: 185,
						type: 'link',
						path: '/Applications',
					},
				],
			},
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
	// buildIdentifier: 'microflow-studio',
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
