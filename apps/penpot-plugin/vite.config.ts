import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build, defineConfig, type Plugin } from "vite";

/**
 * Custom plugin that builds the plugin sandbox entry as a separate IIFE bundle
 * and copies manifest.json to the dist directory.
 *
 * Penpot plugins require two outputs:
 * 1. plugin.js — IIFE bundle for the sandbox (no DOM)
 * 2. ui/ — Standard React app for the iframe UI
 *
 * The main Vite config handles the UI build. This plugin runs a secondary
 * build for the sandbox entry after the UI build completes.
 */
// Read the host from public/manifest.json so plugin.js gets the correct base URL
function getManifestHost(): string {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "public/manifest.json"), "utf-8"),
  );
  return manifest.host;
}

function penpotPluginBuild(): Plugin {
  return {
    name: "penpot-plugin-build",
    apply: "build",
    async closeBundle() {
      // Build the plugin sandbox entry as IIFE
      await build({
        configFile: false,
        define: {
          __PLUGIN_HOST__: JSON.stringify(getManifestHost()),
        },
        build: {
          lib: {
            entry: resolve(__dirname, "src/plugin/plugin.ts"),
            name: "PenpotPlugin",
            formats: ["iife"],
            fileName: () => "plugin.js",
          },
          outDir: resolve(__dirname, "dist"),
          emptyOutDir: false,
          rollupOptions: {
            output: {
              entryFileNames: "plugin.js",
            },
          },
        },
      });

      // Copy manifest.json to dist/ (served from public/ as single source of truth)
      mkdirSync(resolve(__dirname, "dist"), { recursive: true });
      copyFileSync(
        resolve(__dirname, "public/manifest.json"),
        resolve(__dirname, "dist/manifest.json"),
      );
    },
  };
}

/**
 * Dev plugin that builds plugin.js once on server start and serves it.
 * Also watches for changes to plugin source files and rebuilds.
 */
function penpotPluginDev(): Plugin {
  const pluginOutDir = resolve(__dirname, "dist");
  const pluginJsPath = resolve(pluginOutDir, "plugin.js");

  async function buildPlugin() {
    await build({
      configFile: false,
      define: {
        __PLUGIN_HOST__: JSON.stringify("http://localhost:5173"),
      },
      build: {
        lib: {
          entry: resolve(__dirname, "src/plugin/plugin.ts"),
          name: "PenpotPlugin",
          formats: ["iife"],
          fileName: () => "plugin.js",
        },
        outDir: pluginOutDir,
        emptyOutDir: false,
        rollupOptions: {
          output: {
            entryFileNames: "plugin.js",
          },
        },
      },
      logLevel: "warn",
    });
  }

  return {
    name: "penpot-plugin-dev",
    apply: "serve",
    async buildStart() {
      await buildPlugin();
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/plugin.js" && existsSync(pluginJsPath)) {
          res.setHeader("Content-Type", "application/javascript");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(readFileSync(pluginJsPath, "utf-8"));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, "src/ui"),
  publicDir: resolve(__dirname, "public"),
  plugins: [tailwindcss(), react(), penpotPluginBuild(), penpotPluginDev()],
  server: {
    cors: true,
  },
  build: {
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
  },
});
