const { bundle } = require('./bundler');
require('dotenv').config();

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
	packagerConfig: {
		name: 'Microflow studio',
		executableName: 'Microflow studio',
		icon: 'assets/icon',
		osxSign: {
			strictVerify: false,
			identity: process.env.APPLE_IDENTITY, // https://github.com/electron/forge/issues/3131#issuecomment-2237818679
			ignore: filePath => {
				if (filePath.includes('build/node_gyp_bins/python3')) {
					console.log('>> ignore signing', filePath);
					return true;
				}
				return false;
			},
			// optionsForFile: filePath => {
			// 	if (!filePath.includes('node_gyp_bins/python3')) {
			// 		return;
			// 	}

			// 	console.log('>> extra options', filePath);

			// 	return {
			// 		additionalArguments: ['--deep'],
			// 	};
			// },
			// ignore: filePath => {
			// 	if (!filePath.includes('node_gyp_bins/python3')) {
			// 		return false;
			// 	}

			// 	console.log('>> ignore', filePath);
			// 	return true;
			// },
		},
		// osxNotarize: {
		// 	tool: 'notarytool',
		// 	appleId: process.env.APPLE_ID,
		// 	appleIdPassword: process.env.APPLE_PASSWORD,
		// 	teamId: process.env.APPLE_TEAM_ID,
		// },
		prune: false, // Requires for monorepo
		protocols: [
			{
				name: 'microflow-studio',
				schemes: ['mfs', 'microflow-studio'],
			},
		],
	},
	hooks: {
		packageAfterCopy: async (
			forgeConfig,
			buildPath,
			electronVersion,
			platform,
			arch,
		) => {
			console.log(forgeConfig, buildPath, electronVersion, platform, arch);
			// https://gist.github.com/robin-hartmann/ad6ffc19091c9e661542fbf178647047
			// this is a workaround until we find a proper solution
			// for running electron-forge in a mono repository
			await bundle(__dirname, buildPath);
		},
	},
	rebuildConfig: {},
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
