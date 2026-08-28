import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/**
 * Pages that moved. Keep these forever — the app deep-links into the docs, and
 * so do older Studio builds that are still in use.
 */
const movedPages = [
  // Node pages re-filed to match the category the Add node palette puts them in.
  ["/docs/microflow-studio/nodes/internal/monitor", "/docs/microflow-studio/nodes/express/monitor"],
  ["/docs/microflow-studio/nodes/generate/trigger", "/docs/microflow-studio/nodes/decide/trigger"],
  ["/docs/microflow-studio/nodes/decide/counter", "/docs/microflow-studio/nodes/generate/counter"],
];

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return movedPages.map(([source, destination]) => ({
      source,
      destination,
      permanent: true,
    }));
  },
};

export default withMDX(config);
