import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Vite plugin to redirect zod imports from @tscircuit/* packages to zod 3.x.
 * This isolates tscircuit's Zod 3.x dependency from the app's Zod 4.x.
 *
 * The "zod3" package is an npm alias for "zod@3" defined in package.json.
 */
function tscircuitZodPlugin(): Plugin {
  return {
    name: "tscircuit-zod-redirect",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (
        source === "zod" &&
        importer &&
        (importer.includes("@tscircuit") || importer.includes("tscircuit"))
      ) {
        // Let Vite resolve "zod3" (the npm alias) through its normal pipeline
        const resolved = await this.resolve("zod3", importer, {
          ...options,
          skipSelf: true,
        });
        return resolved;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [tscircuitZodPlugin(), tailwindcss(), tanstackRouter({}), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Monaco editor (~7 MB) — only used in function node code editor
          monaco: ["monaco-editor", "@monaco-editor/react"],
          // tscircuit ecosystem — only used on /circuit route
          tscircuit: [
            "tscircuit",
            "@tscircuit/eval",
            "@tscircuit/schematic-viewer",
            "@tscircuit/schematic-autolayout",
            "circuit-json",
          ],
          // React + core libs
          vendor: ["react", "react-dom", "zustand", "yjs"],
        },
      },
    },
  },
  server: {
    port: 3001,
    allowedHosts: ["microflow.tech"],
  },
});
