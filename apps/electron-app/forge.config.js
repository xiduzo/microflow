const { bundle } = require("./bundler");

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  packagerConfig: {
    prune: false,
    protocols: [
      {
        name: "Figma hardware bridge",
        schemes: ["fhb", "figma-hardware-bridge"],
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
      // https://gist.github.com/robin-hartmann/ad6ffc19091c9e661542fbf178647047
      // this is a workaround until we find a proper solution
      // for running electron-forge in a mono repository
      await bundle(__dirname, buildPath);
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {},
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-deb",
      config: {
        mimeType: [
          "x-scheme-handler/fhb",
          "x-scheme-handler/figma-hardware-bridge",
        ],
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      config: {},
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-vite",
      config: {
        // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
        // If you are familiar with Vite configuration, it will look really familiar.
        build: [
          // Workers
          {
            entry: "src/main/workers/check.js",
            config: "vite.worker.config.mjs",
          },
          // Rest
          {
            // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
            entry: "src/main.js",
            config: "vite.main.config.mjs",
          },
          {
            entry: "src/preload.ts",
            config: "vite.preload.config.mjs",
          },
        ],
        renderer: [
          {
            name: "main_window",
            config: "vite.renderer.config.mjs",
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
          owner: 'Xiduzo',
          name: 'Figma-Hardware-Bridge'
        },
        prerelease: true
      }
    }
  ]
};
