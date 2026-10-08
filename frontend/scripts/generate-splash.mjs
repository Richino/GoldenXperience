// Renders the iOS PWA launch screens (apple-touch-startup-image) into
// public/splash/. iOS shows one only when its media query matches the
// device's CSS size and pixel ratio exactly, so every screen needs its own.
// Android builds its splash from manifest.json (background_color, name and
// the 512px icon) and needs nothing here.
//
//   node scripts/generate-splash.mjs

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { SPLASH_DEVICES } from "../src/lib/pwa/splash-devices.ts";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "public", "splash");
fs.mkdirSync(outDir, { recursive: true });

// The mark from brand-icon.svg without its tile, so it sits on the page.
const icon = fs.readFileSync(path.join(root, "public", "brand-icon.svg"), "utf8");
const markOnly = icon
  .replace(/<rect x="5" y="4"[^>]*\/>\s*/, "")
  .replace(/<rect x="5\.5"[^>]*\/>\s*/, "");

for (const device of SPLASH_DEVICES) {
  const width = device.width * device.ratio;
  const height = device.height * device.ratio;
  const markSize = Math.round(Math.min(width, height) * 0.42);
  const mark = await sharp(Buffer.from(markOnly), { density: 400 }).resize(markSize, markSize).png().toBuffer();
  await sharp({ create: { width, height, channels: 3, background: "#0b0c0a" } })
    .composite([{ input: mark, left: Math.round((width - markSize) / 2), top: Math.round((height - markSize) / 2) }])
    .png()
    .toFile(path.join(outDir, `${width}x${height}.png`));
  console.log(`splash/${width}x${height}.png`);
}
