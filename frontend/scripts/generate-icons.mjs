import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);
const svgPath = path.join(publicDir, "icon.svg");

const targets = [
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "icon-maskable-192.png", size: 192 },
  { name: "icon-maskable-512.png", size: 512 },
  { name: "apple-touch-icon.png", size: 180 },
];

async function generateIcons() {
  const svg = fs.readFileSync(svgPath);

  for (const { name, size } of targets) {
    await sharp(svg)
      .resize(size, size, {
        fit: "contain",
        background: { r: 16, g: 185, b: 129, alpha: 1 },
      })
      .png()
      .toFile(path.join(publicDir, name));

    console.info(`Generated ${name} (${size}x${size})`);
  }
}

generateIcons().catch((error) => {
  console.error(`Icon generation failed: ${error.message}`);
  process.exit(1);
});
