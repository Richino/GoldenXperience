// Renders the iOS PWA launch screens (apple-touch-startup-image) into
// public/splash/. iOS shows one only when its media query matches the
// device's CSS size and pixel ratio exactly, so every screen needs its own.
// Android builds its system splash from manifest.json and its app icon.
//
//   node scripts/generate-splash.mjs

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { SPLASH_DEVICES } from "../src/lib/pwa/splash-devices.ts";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "public", "splash");
const artwork = path.join(root, "assets", "splash-artwork.png");
fs.mkdirSync(outDir, { recursive: true });

for (const device of SPLASH_DEVICES) {
  const width = device.width * device.ratio;
  const height = device.height * device.ratio;
  // Fill wider screens with a dark, softened version of the same artwork.
  // The sharp foreground stays fully visible, preserving the logo on iPad
  // and the shorter legacy iPhones instead of cropping it off the top.
  const backdrop = await sharp(artwork)
    .resize(width, height, { fit: "cover" })
    .blur(32)
    .modulate({ brightness: 0.3 })
    .png()
    .toBuffer();
  const foreground = await sharp(artwork)
    .resize(width, height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await sharp(backdrop)
    .composite([{ input: foreground }])
    .png({ palette: true, quality: 90, effort: 6 })
    .toFile(path.join(outDir, `gx-${width}x${height}.png`));
  console.log(`splash/gx-${width}x${height}.png`);
}
