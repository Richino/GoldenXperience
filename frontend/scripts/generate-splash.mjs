// iOS selects a launch PNG by screen dimensions and pixel ratio.
// Android uses the manifest background and icons built from the same SVG.
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { SPLASH_DEVICES } from "../src/lib/pwa/splash-devices.ts";

const publicDir = path.resolve(import.meta.dirname, "../public");
const outDir = path.join(publicDir, "splash");
const source = await fs.readFile(path.join(publicDir, "brand-icon.svg"));
await fs.mkdir(outDir, { recursive: true });

for (const device of SPLASH_DEVICES) {
  const width = device.width * device.ratio;
  const height = device.height * device.ratio;
  // Match the centered logo in welcome-screen.module.css.
  const size = Math.round(Math.min(184, 0.44 * device.width, 0.32 * device.height) * device.ratio);
  const logo = await sharp(source).resize(size, size).png().toBuffer();
  const name = `gx-${width}x${height}.png`;
  await sharp({ create: { width, height, channels: 3, background: "#0b0c0a" } })
    .composite([{ input: logo, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(outDir, name));
  console.log(`splash/${name}`);
}
