import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const LOGO = join(ROOT, "logo.svg");

const WEB_PUBLIC = join(ROOT, "apps/web/public");
const DOCS_APP = join(ROOT, "apps/fumadocs/src/app");
const DOCS_PUBLIC = join(ROOT, "apps/fumadocs/public");

const BG = "#1E293B";

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function loadSquareBuffer({ size, background = { r: 0, g: 0, b: 0, alpha: 0 }, inset = 1 }) {
  const svg = await readFile(LOGO);
  const inner = Math.round(size * inset);
  const rendered = await sharp(svg, { density: 384 })
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background,
    },
  })
    .composite([{ input: rendered, gravity: "center" }])
    .png()
    .toBuffer();
}

function hexToRgba(hex, alpha = 1) {
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return { r, g, b, alpha };
}

async function writePng(outPath, size, opts = {}) {
  const buf = await loadSquareBuffer({ size, ...opts });
  await ensureDir(dirname(outPath));
  await writeFile(outPath, buf);
  console.log("wrote", outPath);
}

async function writeIco(outPath, sizes) {
  const buffers = await Promise.all(
    sizes.map((s) => loadSquareBuffer({ size: s })),
  );
  const ico = await pngToIco(buffers);
  await ensureDir(dirname(outPath));
  await writeFile(outPath, ico);
  console.log("wrote", outPath);
}

async function writeSvgPassthrough(outPath) {
  const svg = await readFile(LOGO);
  await ensureDir(dirname(outPath));
  await writeFile(outPath, svg);
  console.log("wrote", outPath);
}

async function buildFor(targetDir, { manifestDir = targetDir, manifestPath = "site.webmanifest" } = {}) {
  await ensureDir(targetDir);

  await writePng(join(targetDir, "favicon-16x16.png"), 16);
  await writePng(join(targetDir, "favicon-32x32.png"), 32);
  await writePng(join(targetDir, "favicon-48x48.png"), 48);
  await writePng(join(targetDir, "apple-touch-icon.png"), 180, { background: hexToRgba(BG, 1), inset: 0.85 });
  await writePng(join(targetDir, "android-chrome-192x192.png"), 192);
  await writePng(join(targetDir, "android-chrome-512x512.png"), 512);
  await writePng(join(targetDir, "maskable-icon-512x512.png"), 512, { background: hexToRgba(BG, 1), inset: 0.7 });
  await writePng(join(targetDir, "og-image.png"), 1200, { background: hexToRgba(BG, 1), inset: 0.55 });

  await writeIco(join(targetDir, "favicon.ico"), [16, 32, 48]);
  await writeSvgPassthrough(join(targetDir, "icon.svg"));

  const manifest = {
    name: "microflow",
    short_name: "microflow",
    icons: [
      { src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
      { src: "/maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    theme_color: BG,
    background_color: BG,
    display: "standalone",
  };
  await ensureDir(manifestDir);
  await writeFile(join(manifestDir, manifestPath), JSON.stringify(manifest, null, 2));
  console.log("wrote", join(manifestDir, manifestPath));
}

await buildFor(WEB_PUBLIC);
await buildFor(DOCS_PUBLIC);

// Next.js App Router convention: place primary icons inside app/ for auto-discovery
await ensureDir(DOCS_APP);
await writeSvgPassthrough(join(DOCS_APP, "icon.svg"));
await writePng(join(DOCS_APP, "apple-icon.png"), 180, { background: hexToRgba(BG, 1), inset: 0.85 });
await writeIco(join(DOCS_APP, "favicon.ico"), [16, 32, 48]);

console.log("done");
