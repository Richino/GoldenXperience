// Renders the iOS PWA launch screens (apple-touch-startup-image) into
// public/splash/. iOS shows one only when its media query matches the
// device's CSS size and pixel ratio exactly, so every screen needs its own.
//
// They are plain app-background colour on purpose: the real splash is the
// in-app robot screen (components/welcome/welcome-screen.tsx), so the system
// image only has to avoid a white flash before it. Android builds its own
// from manifest.json (background_color + icon).
//
//   node scripts/generate-splash.mjs
//
// Pure Node (zlib), no native image library.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { SPLASH_DEVICES } from "../src/lib/pwa/splash-devices.ts";

const BACKGROUND = [0x0b, 0x0c, 0x0a];
const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "public", "splash");
fs.mkdirSync(outDir, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid-colour RGB PNG. */
function solidPng(width, height, [r, g, b]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const device of SPLASH_DEVICES) {
  const width = device.width * device.ratio;
  const height = device.height * device.ratio;
  fs.writeFileSync(path.join(outDir, `gx-${width}x${height}.png`), solidPng(width, height, BACKGROUND));
  console.log(`splash/gx-${width}x${height}.png`);
}
