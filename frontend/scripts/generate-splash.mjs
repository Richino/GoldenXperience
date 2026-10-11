// Renders the iOS PWA launch screens (apple-touch-startup-image) into
// public/splash/. iOS shows one only when its media query matches the
// device's CSS size and pixel ratio exactly, so every screen needs its own.
//
// Each image is the in-app splash (components/welcome/welcome-screen.tsx,
// welcome-screen.module.css) without its text: the same background, glow,
// grid, orbit rings and the mascot's first frame at the exact spot the page
// lays it out on that device. iOS shows it the instant the app is tapped,
// the page's own splash then appears over it with the title fading in, so
// there is no blank screen in between. Android builds its own system splash
// from manifest.json (background_color + icon).
//
//   node scripts/generate-splash.mjs

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { SPLASH_DEVICES } from "../src/lib/pwa/splash-devices.ts";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "public", "splash");
const mascotSource = path.join(root, "public", "splash", "gx-mascot-loop.webp");
fs.mkdirSync(outDir, { recursive: true });

// Dynamic Island iPhones (CSS widths) have a 59px status bar; notch ones 47.
const ISLAND_WIDTHS = new Set([393, 402, 420, 430, 440]);

/** Status bar / home indicator insets a home-screen app gets on this device. */
function safeInsets({ width, height }) {
  const iPad = width >= 700;
  if (iPad) return height >= 1133 || width === 744 ? { top: 24, bottom: 20 } : { top: 20, bottom: 0 };
  if (height >= 812) return { top: ISLAND_WIDTHS.has(width) ? 59 : 47, bottom: 34 };
  return { top: 20, bottom: 0 };
}

/** Where welcome-screen.module.css places the mascot, in CSS px. */
function mascotBox(device) {
  const W = device.width;
  const H = device.height;
  const { top, bottom } = safeInsets(device);
  const padTop = Math.max(30, top);
  const padBottom = Math.max(24, bottom);
  const size = Math.min(256, 0.58 * W, 0.36 * H); // .character width
  const title = Math.min(54, Math.max(25, 0.068 * W)) * 1.15; // h1 clamp × line-height
  const eyebrow = 15 + 14; // 10px mono line (15px tall) + margin
  const tagline = 12 + 21; // margin + 14px line (21px tall)
  const block = size + 38 + eyebrow + title + tagline; // .character margin-bottom 38
  const area = H - padTop - padBottom - 22; // .footer pulse is 22px tall
  const y = padTop + (area - 12 - block) / 2; // .center padding-bottom 12
  return { x: (W - size) / 2, y, size };
}

const mascotFrame = await sharp(mascotSource, { animated: false }).png().toBuffer();

for (const device of SPLASH_DEVICES) {
  const r = device.ratio;
  const W = device.width * r;
  const H = device.height * r;
  const box = mascotBox(device);
  const size = Math.round(box.size * r);
  const left = Math.round(box.x * r);
  const top = Math.round(box.y * r);
  const glow = Math.min(680, 1.5 * device.width) * r;
  const cx = W / 2;
  const cy = top + size / 2;
  const ring = size / 2 + 10 * r;

  const backdrop = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <radialGradient id="glow" cx="${W / 2}" cy="${0.45 * H}" r="${glow / 2}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#c8f560" stop-opacity="0.078"/>
        <stop offset="0.38" stop-color="#c8f560" stop-opacity="0.02"/>
        <stop offset="0.68" stop-color="#c8f560" stop-opacity="0"/>
      </radialGradient>
      <pattern id="grid" width="${56 * r}" height="${56 * r}" patternUnits="userSpaceOnUse">
        <path d="M0 0H${56 * r}M0 0V${56 * r}" stroke="#c8f560" stroke-opacity="0.031" stroke-width="${r}"/>
      </pattern>
      <radialGradient id="fade" cx="${W / 2}" cy="${0.42 * H}" r="${0.7 * Math.max(W, H) / 2}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#fff" stop-opacity="1"/>
        <stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
      <mask id="gridMask"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>
    </defs>
    <rect width="${W}" height="${H}" fill="#0b0c0a"/>
    <rect width="${W}" height="${H}" fill="url(#grid)" mask="url(#gridMask)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    <circle cx="${cx}" cy="${cy}" r="${ring}" fill="none" stroke="#c8f560" stroke-opacity="0.125" stroke-width="${r}"/>
    <circle cx="${cx}" cy="${cy}" r="${ring - 15 * r}" fill="none" stroke="#c8f560" stroke-opacity="0.075" stroke-width="${r}" stroke-dasharray="${3 * r} ${3 * r}"/>
  </svg>`;

  const mascot = await sharp(mascotFrame).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp(Buffer.from(backdrop))
    .composite([{ input: mascot, left, top }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(outDir, `gx-${W}x${H}.png`));
  console.log(`splash/gx-${W}x${H}.png  mascot ${Math.round(box.size)}px at y=${Math.round(box.y)}`);
}
