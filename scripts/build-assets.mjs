// Build the committed image assets for Whisper Wall: the favicon raster
// fallbacks and the Open Graph / Twitter preview image.
//
// This is a BUILD-TIME tool, not a runtime dependency. Following the repo
// convention (see check-files.mjs), sharp is pulled in transiently:
//
//     npm install --no-save sharp
//     node scripts/build-assets.mjs
//
// Inputs (committed, so the build is reproducible):
//   favicon.svg          source of truth for the icon
//   scripts/og-source.png a real stroke captured from the live wall, the words
//                         "Whisper Wall" spoken. The OG image is built FROM it.
//
// Outputs (committed):
//   favicon-32.png, apple-touch-icon.png, og-image.png
//
// NOTE on swapping the OG image later: you do NOT need to rerun this script.
// Drop a replacement 1200x630 og-image.png in the repo root and the meta tags
// (which point at a fixed filename) keep working. This script only matters if
// you want to regenerate from a new captured stroke.

import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Wall palette, lifted verbatim from wall.html :root.
const PAPER = { r: 0xf4, g: 0xed, b: 0xe0 }; // #f4ede0
const INK = { r: 0x1a, g: 0x16, b: 0x12 }; //   #1a1612
const INK_SOFT_ALPHA = 0.55; //                 --ink-soft

const OG_W = 1200;
const OG_H = 630;

// --- Favicons ----------------------------------------------------------------
// Rasterize the SVG at high density, then downscale, so edges stay crisp.
async function buildFavicons() {
  const svg = join(root, 'favicon.svg');
  await sharp(svg, { density: 512 })
    .resize(32, 32)
    .png({ compressionLevel: 9 })
    .toFile(join(root, 'favicon-32.png'));
  await sharp(svg, { density: 512 })
    .resize(180, 180)
    .png({ compressionLevel: 9 })
    .toFile(join(root, 'apple-touch-icon.png'));
  console.log('favicons: favicon-32.png (32x32), apple-touch-icon.png (180x180)');
}

// --- OG image ----------------------------------------------------------------
// The captured stroke's own paper tone drifts slightly from #f4ede0, so pasting
// the bitmap would leave a visible rectangle. Instead we treat DARKNESS AS ALPHA:
// each source pixel's luminance becomes an opacity for pure ink painted over one
// uniform paper fill. The captured background maps to alpha 0 and never appears,
// guaranteeing a single paper color with no seam. Partial alphas keep the splatter.
function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.114 * b;
}

async function extractInk() {
  const { data, info } = await sharp(join(root, 'scripts', 'og-source.png'))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // Luminance histogram -> robust paper (median) and ink (1st percentile) refs.
  const hist = new Array(256).fill(0);
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += channels, p++) {
    const L = luminance(data[i], data[i + 1], data[i + 2]);
    lum[p] = L;
    hist[Math.min(255, Math.max(0, Math.round(L)))]++;
  }
  const total = width * height;
  const pct = (frac) => {
    let acc = 0;
    const target = total * frac;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v;
    }
    return 255;
  };
  // Paper is a tight bright cluster (the vast majority of pixels). The white
  // point sits just below it so the whole paper field maps to alpha 0; the black
  // point sits down near the real ink so the dynamic range is wide. A wide span
  // is what keeps faint paper noise near zero (a narrow span would amplify it
  // into a visible wash and a false full-frame bounding box).
  const paperRef = pct(0.5); // median is squarely in the paper cluster
  const whitePoint = paperRef - 2;
  const blackPoint = Math.max(24, paperRef - 200);

  // Dust floor: alpha below this is treated as background noise / tonal drift
  // and zeroed, so the canvas stays a single clean paper color. Low enough that
  // the faint trailing splatter (real, darker than noise) still survives.
  const FLOOR = 0.05;
  const span = Math.max(1, whitePoint - blackPoint);

  const out = Buffer.alloc(width * height * 4);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  let inkPixels = 0;
  for (let p = 0; p < total; p++) {
    let a = (whitePoint - lum[p]) / span; // paper -> <=0, ink -> 1
    if (a < FLOOR) a = 0;
    if (a > 1) a = 1;
    const o = p * 4;
    out[o] = INK.r;
    out[o + 1] = INK.g;
    out[o + 2] = INK.b;
    out[o + 3] = Math.round(a * 255);
    if (out[o + 3] >= 13) {
      // bbox only from inked pixels (alpha >= floor) so paper noise can't
      // balloon it; faint splatter and tails near the stroke are included.
      const x = p % width;
      const y = (p / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      inkPixels++;
    }
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  console.log(
    `ink extract: white=${whitePoint} black=${blackPoint} floor=${FLOOR} ` +
      `bbox=${bw}x${bh} inkPixels=${inkPixels}`,
  );
  if (bw > width * 0.95 && bh > height * 0.95) {
    throw new Error('bbox spans the whole frame — background is leaking into ink');
  }
  // Crop to the stroke's tight bounds (no padding; the canvas supplies paper).
  const cropped = await sharp(out, { raw: { width, height, channels: 4 } })
    .extract({ left: minX, top: minY, width: bw, height: bh })
    .png()
    .toBuffer();
  return { cropped, bw, bh };
}

async function buildOgImage() {
  const { cropped, bw, bh } = await extractInk();

  // Scale the stroke to sit comfortably with plenty of paper around it: target
  // ~58% of canvas width, but never taller than ~60% of canvas height. Never
  // cropped — extra paper letterboxes it (consistent with the aesthetic).
  let targetW = Math.round(OG_W * 0.58);
  let targetH = Math.round((targetW / bw) * bh);
  const maxH = Math.round(OG_H * 0.6);
  if (targetH > maxH) {
    targetH = maxH;
    targetW = Math.round((targetH / bh) * bw);
  }
  const stroke = await sharp(cropped).resize(targetW, targetH).png().toBuffer();
  const left = Math.round((OG_W - targetW) / 2);
  const top = Math.round((OG_H - targetH) / 2);

  // Title in the same spirit as the site header: serif, uppercase, wide tracking,
  // ink-soft, quiet in the top-left. Georgia is reliably present in the build
  // rasterizer's font set and matches the site's serif fallback chain.
  const fontSize = 24;
  const tracking = (fontSize * 0.35).toFixed(2); // 0.35em, matching .title
  const titleSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}">` +
      `<text x="56" y="62" font-family="Georgia, 'Times New Roman', serif" ` +
      `font-size="${fontSize}" letter-spacing="${tracking}" font-weight="400" ` +
      `fill="rgb(${INK.r},${INK.g},${INK.b})" fill-opacity="${INK_SOFT_ALPHA}">` +
      `WHISPER WALL</text></svg>`,
  );

  await sharp({
    create: {
      width: OG_W,
      height: OG_H,
      channels: 4,
      background: { ...PAPER, alpha: 1 },
    },
  })
    .composite([
      { input: stroke, left, top },
      { input: titleSvg, left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(join(root, 'og-image.png'));
  console.log(`og-image.png: ${OG_W}x${OG_H}, stroke ${targetW}x${targetH} at (${left},${top})`);
  return { left, top, targetW, targetH };
}

// --- Verification ------------------------------------------------------------
async function verifyOg(place) {
  const { data, info } = await sharp(join(root, 'og-image.png'))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const at = (x, y) => {
    const o = (y * width + x) * channels;
    return [data[o], data[o + 1], data[o + 2]];
  };
  const isPaper = ([r, g, b]) => r === PAPER.r && g === PAPER.g && b === PAPER.b;

  // 1) Seam / uniform-paper check. Background points must be EXACT paper. The
  // last four sit just INSIDE the corners of where the captured frame was
  // composited — that is exactly where a tonal-drift rectangle would show, so
  // these are the points that actually prove there is no seam.
  const ix = place.left + 6, iy = place.top + 6;
  const ix2 = place.left + place.targetW - 6, iy2 = place.top + place.targetH - 6;
  const samples = [
    [40, 40], [width - 40, 40], [40, height - 40], [width - 40, height - 40],
    [600, 60], [600, height - 60], [60, 315], [width - 60, 315],
    [ix, iy], [ix2, iy], [ix, iy2], [ix2, iy2],
  ];
  const bad = samples.filter((s) => !isPaper(at(s[0], s[1])));
  if (bad.length) {
    console.error('SEAM CHECK FAILED at', bad, '->', bad.map((s) => at(s[0], s[1])));
    process.exitCode = 1;
  } else {
    console.log(`seam check: PASS (${samples.length} background points all exactly #f4ede0)`);
  }

  // 2) Title actually rendered: count non-paper pixels in the header region.
  let titlePixels = 0;
  for (let y = 40; y < 70; y++)
    for (let x = 50; x < 360; x++) if (!isPaper(at(x, y))) titlePixels++;
  console.log(`title check: ${titlePixels} ink pixels in header region ${titlePixels > 200 ? 'PASS' : 'FAIL — title did not draw'}`);
  if (titlePixels <= 200) process.exitCode = 1;

  // 3) Splatter preserved: count non-paper pixels across the whole canvas and
  // confirm ink reaches well out toward the stroke's horizontal extremes.
  let inkTotal = 0, minIx = width, maxIx = 0;
  for (let y = 80; y < height; y++)
    for (let x = 0; x < width; x++)
      if (!isPaper(at(x, y))) { inkTotal++; if (x < minIx) minIx = x; if (x > maxIx) maxIx = x; }
  console.log(`splatter check: ${inkTotal} ink pixels, horizontal extent x=${minIx}..${maxIx}`);
}

await buildFavicons();
const place = await buildOgImage();
await verifyOg(place);
console.log('done.');
