import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Vite plugin to redirect zod imports from @tscircuit/* packages to zod3.
 * This isolates tscircuit's Zod 3.x dependency from the app's Zod 4.x.
 */
function tscircuitZodPlugin(): Plugin {
  return {
    name: "tscircuit-zod-redirect",
    enforce: "pre",
    resolveId(source, importer) {
      // Only intercept 'zod' imports from tscircuit packages
      if (
        source === "zod" &&
        importer &&
        (importer.includes("@tscircuit") || importer.includes("tscircuit"))
      ) {
        return { id: "zod3", external: false };
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
  server: {
    port: 3001,
  },
});
