/**
 * Builds every platform icon from one source: public/brand-icon.svg, the same
 * mark the header renders. Run by `npm run build`.
 *
 * The three families are not the same image at different sizes, because the
 * platforms mask them differently:
 *
 * - "any"      keeps the mark's own rounded square. Used by the manifest and
 *              by desktop browsers, neither of which crops.
 * - apple      is full bleed and opaque. iOS applies its own squircle, so a
 *              pre-rounded icon shows dark wedges in the corners, and any
 *              transparency is composited onto black.
 * - maskable   is full bleed with the mark inset. Android crops to a shape it
 *              picks, guaranteeing only the centre circle survives.
 *
 * Full bleed comes free here: the brand mark's own background is BRAND_BG, so
 * compositing it onto a BRAND_BG canvas hides the rounded corners seamlessly.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const appDir = path.join(root, "src", "app");
const source = fs.readFileSync(path.join(publicDir, "brand-icon.svg"));

/** The mark's own background, so composites blend into a seamless square. */
const BRAND_BG = { r: 11, g: 11, b: 9, alpha: 1 };

/**
 * Android's maskable safe zone is a circle of 80% diameter, so a square mark
 * only survives every mask shape below 80/√2 ≈ 57% of the canvas. The mark
 * fills ~67% of the source, so rendering the source at 88% lands it at ~59% —
 * within the safe zone on any realistic mask, without looking lost in padding.
 */
const MASKABLE_SOURCE_SCALE = 0.88;

/**
 * At tab size the three candlesticks collapse into noise beside the X and cost
 * more legibility than they add, so small icons drop them and keep the GX.
 * Every candlestick path is stroked and no path in the core mark is, which
 * makes the split exact rather than a guess at path order.
 */
const simplified = Buffer.from(
  source.toString("utf8").replace(/\s*<path\b[^>]*\bstroke="[^"]*"[^>]*\/>/g, ""),
);
const SIMPLIFY_BELOW = 64;
const sourceFor = (size) => (size < SIMPLIFY_BELOW ? simplified : source);

const square = (size) => sharp({ create: { width: size, height: size, channels: 4, background: BRAND_BG } });

/** Transparent outside the mark's rounded corners. */
async function anyIcon(size) {
  return sharp(sourceFor(size)).resize(size, size).png().toBuffer();
}

/** Opaque, full bleed, corners blended away. */
async function opaqueIcon(size, scale = 1) {
  const inner = Math.round(size * scale);
  const mark = await sharp(sourceFor(size)).resize(inner, inner).png().toBuffer();
  return square(size)
    .composite([{ input: mark, gravity: "centre" }])
    .flatten({ background: BRAND_BG })
    .png()
    .toBuffer();
}

/**
 * ICO is a directory of embedded PNGs. Sharp cannot write the container, and
 * the format is small enough to assemble directly.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 encodes 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

async function generateIcons() {
  const written = [];
  const write = (dir, name, data) => {
    fs.writeFileSync(path.join(dir, name), data);
    written.push(name);
  };

  // Manifest icons, plus the notification icon referenced by sw.js.
  for (const size of [192, 512]) {
    write(publicDir, `icon-${size}.png`, await anyIcon(size));
    write(publicDir, `icon-maskable-${size}.png`, await opaqueIcon(size, MASKABLE_SOURCE_SCALE));
  }

  // Apple. src/app/apple-icon.png is the file convention Next emits a
  // <link rel="apple-touch-icon"> for; the public copy stays because iOS
  // probes /apple-touch-icon.png directly when a link tag is missed.
  const apple = await opaqueIcon(180);
  write(appDir, "apple-icon.png", apple);
  write(publicDir, "apple-touch-icon.png", apple);

  // Browser tab. The SVG is what modern browsers use and it stays crisp at
  // any zoom; the .ico carries the raster sizes Windows and older browsers
  // still ask for.
  write(appDir, "icon.svg", simplified);
  write(appDir, "favicon.ico", buildIco(await Promise.all(
    [16, 32, 48].map(async (size) => ({ size, data: await opaqueIcon(size) })),
  )));

  console.info(`Generated ${written.length} icons from brand-icon.svg: ${written.join(", ")}`);
}

generateIcons().catch((error) => {
  console.error(`Icon generation failed: ${error.message}`);
  process.exit(1);
});
