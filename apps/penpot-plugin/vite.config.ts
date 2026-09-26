import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { type Plugin, build, defineConfig } from "vite";

const OUT_DIR = resolve(__dirname, "dist");

/** Penpot runs `plugin.js` in its sandbox as one classic script, so it is built apart from the UI. */
async function buildSandbox(write: boolean): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "warn",
    build: {
      lib: {
        entry: resolve(__dirname, "src/plugin/plugin.ts"),
        name: "MicroflowPenpotPlugin",
        formats: ["iife"],
        fileName: () => "plugin.js",
      },
      outDir: OUT_DIR,
      emptyOutDir: false,
      write,
    },
  });
  const [output] = Array.isArray(result) ? result : [result];
  if (!output || !("output" in output)) throw new Error("Unexpected sandbox build result");
  return output.output[0].code;
}

function penpotSandbox(): Plugin {
  return {
    name: "penpot-sandbox",
    async closeBundle() {
      await buildSandbox(true);
    },
    configureServer(server) {
      server.middlewares.use("/plugin.js", (_req, res, next) => {
        buildSandbox(false).then((code) => {
          res.setHeader("Content-Type", "text/javascript");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(code);
        }, next);
      });
    },
  };
}

/**
 * The manifest is a version 2 manifest: Penpot resolves `plugin.js`, `icon.png`
 * and `ui/index.html` against the manifest's own URL, so `dist/` can be served
 * from any path. The same layout is served in development.
 */
export default defineConfig({
  root: resolve(__dirname, "src"),
  base: "./",
  publicDir: resolve(__dirname, "public"),
  plugins: [tailwindcss(), react(), penpotSandbox()],
  server: {
    cors: true,
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    assetsDir: "ui/assets",
    rollupOptions: {
      input: resolve(__dirname, "src/ui/index.html"),
    },
  },
});
