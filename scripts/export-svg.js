#!/usr/bin/env node
/**
 * TwinCore — SVG → PNG asset exporter.
 *
 * Renders the brand SVGs in assets/svg/ to the launcher PNG densities
 * Android expects (mipmap-*), plus a set of general-purpose PNGs under
 * assets/png/.
 *
 * Densities: mdpi 48, hdpi 72, xhdpi 96, xxhdpi 144, xxxhdpi 192.
 *
 * Usage:
 *   node scripts/export-svg.js           # export everything
 *   node scripts/export-svg.js --check   # verify sharp is available only
 *
 * Requires: yarn add -D sharp   (installed on demand if missing)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SVG_DIR = path.join(ROOT, 'assets', 'svg');
const RES_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const PNG_OUT = path.join(ROOT, 'assets', 'png');

const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

// Adaptive-icon PNGs are rendered at 108dp; the launcher PNGs at 48dp.
const ADAPTIVE_SCALE = 108 / 48;

/**
 * What to render and where it goes.
 *
 * - `mipmap` entries land in android/app/src/main/res/mipmap-<density>/
 *   (classic launcher icons consumed by API < 26 and by some launchers).
 * - `assets` entries land in assets/png/ for READMEs, store listings, etc.
 */
const JOBS = [
  {
    svg: 'ic_launcher_foreground.svg',
    kind: 'mipmap',
    name: 'ic_launcher_foreground.png',
    adaptive: true,
  },
  {
    svg: 'ic_launcher_background.svg',
    kind: 'mipmap',
    name: 'ic_launcher_background.png',
    adaptive: true,
  },
  {
    svg: 'ic_launcher.svg',
    kind: 'mipmap',
    name: 'ic_launcher.png',
    adaptive: false,
  },
  {
    svg: 'ic_launcher_round.svg',
    kind: 'mipmap',
    name: 'ic_launcher_round.png',
    adaptive: false,
  },
  {
    svg: 'logo-mark.svg',
    kind: 'assets',
    name: 'logo-mark.png',
    adaptive: false,
  },
  {
    svg: 'logo-primary.svg',
    kind: 'assets',
    name: 'logo-primary.png',
    adaptive: false,
  },
  {
    svg: 'logo-wordmark.svg',
    kind: 'assets',
    name: 'logo-wordmark.png',
    adaptive: false,
  },
  {
    svg: 'logo_monochrome.svg',
    kind: 'assets',
    name: 'logo-monochrome.png',
    adaptive: false,
  },
  {
    svg: 'splash_logo.svg',
    kind: 'assets',
    name: 'splash-logo.png',
    adaptive: false,
  },
];

async function main() {
  const argv = process.argv.slice(2);
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    console.error(
      '[export-svg] sharp is not installed. Run:\n' +
        '  yarn add -D sharp\n' +
        'then re-run this script.',
    );
    process.exit(2);
  }

  if (argv.includes('--check')) {
    console.log('[export-svg] sharp OK:', sharp.versions.vips);
    return;
  }

  if (!fs.existsSync(SVG_DIR)) {
    console.error(`[export-svg] missing directory: ${SVG_DIR}`);
    process.exit(1);
  }

  // ic_launcher.png (squircle) is composed: background plate + foreground
  // mark, masked to a rounded square, then scaled per density.
  async function renderLauncherSquircle(size) {
    const bg = path.join(SVG_DIR, 'ic_launcher_background.svg');
    const fg = path.join(SVG_DIR, 'ic_launcher_foreground.svg');
    const fgBuf = await sharp(fg).resize(108, 108).png().toBuffer();
    const mask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108"><rect x="0" y="0" width="108" height="108" rx="20" ry="20" fill="#fff"/></svg>`,
    );
    const base = await sharp(bg)
      .resize(108, 108)
      .composite([{input: fgBuf, blend: 'over'}])
      .png()
      .toBuffer();
    const masked = await sharp(base)
      .composite([{input: mask, blend: 'dest-in'}])
      .png()
      .toBuffer();
    return sharp(masked).resize(size, size).png().toBuffer();
  }

  let written = 0;
  for (const job of JOBS) {
    const src = path.join(SVG_DIR, job.svg);
    // ic_launcher.png is composed from background+foreground, no source file.
    if (job.svg !== 'ic_launcher.svg' && !fs.existsSync(src)) {
      console.warn(`[export-svg] WARN  missing ${job.svg} — skipped`);
      continue;
    }

    if (job.kind === 'mipmap') {
      for (const [density, size] of DENSITIES) {
        const outDir = path.join(RES_DIR, `mipmap-${density}`);
        fs.mkdirSync(outDir, {recursive: true});
        const out = path.join(outDir, job.name);
        let buf;
        let px;
        if (job.svg === 'ic_launcher.svg') {
          px = size;
          buf = await renderLauncherSquircle(size);
        } else {
          px = job.adaptive ? Math.round(size * ADAPTIVE_SCALE) : size;
          buf = await sharp(src).resize(px, px).png().toBuffer();
        }
        fs.writeFileSync(out, buf);
        written += 1;
        console.log(`[export-svg] OK    ${path.relative(ROOT, out)} (${px}px)`);
      }
    } else {
      const outDir = PNG_OUT;
      fs.mkdirSync(outDir, {recursive: true});
      const out = path.join(outDir, job.name);
      await sharp(src).resize(1024, 1024, {fit: 'inside'}).png().toFile(out);
      written += 1;
      console.log(`[export-svg] OK    ${path.relative(ROOT, out)} (1024px)`);
    }
  }

  console.log(`[export-svg] done — ${written} files written.`);
}

main().catch(err => {
  console.error('[export-svg] FAILED:', err.message);
  process.exit(1);
});
