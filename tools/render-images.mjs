#!/usr/bin/env node
/**
 * tools/render-images.mjs — optional, run by hand (not part of the CI build).
 *
 * Rasterises the SVG social cards and icons to PNG with a locally installed
 * Chrome/Chromium in headless mode, and writes them to src/static/ so they are
 * committed and copied by build.mjs. No npm dependencies.
 *
 *   node build.mjs && node tools/render-images.mjs && node build.mjs
 *
 * Set CHROME=/path/to/chrome if it is not found automatically.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'src', 'static');

const candidates = [
  process.env.CHROME,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) {
  console.error('No Chrome/Chromium found. Set CHROME=/path/to/chrome.');
  process.exit(1);
}
if (!existsSync(path.join(DIST, 'og'))) {
  console.error('Run `node build.mjs` first (dist/og/*.svg is missing).');
  process.exit(1);
}

const work = await mkdtemp(path.join(tmpdir(), 'render-images-'));

async function shot(svgMarkup, width, height, outFile) {
  // Wrap the SVG in a page sized exactly to the target so nothing is scaled or cropped.
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style>${svgMarkup}`;
  const page = path.join(work, `${path.basename(outFile)}.html`);
  await writeFile(page, html);
  await mkdir(path.dirname(outFile), { recursive: true });
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=1', '--default-background-color=00000000',
    `--window-size=${width},${height}`, `--screenshot=${outFile}`, pathToFileURL(page).href,
  ], { stdio: 'ignore' });
  console.log(`  ${path.relative(ROOT, outFile)}  ${width}×${height}`);
}

console.log(`Using ${chrome}`);
// Record which SVG each PNG was rendered from, so build.mjs can flag stale cards.
const record = {};
for (const f of (await readdir(path.join(DIST, 'og'))).filter((f) => f.endsWith('.svg')).sort()) {
  const svg = await readFile(path.join(DIST, 'og', f), 'utf8');
  await shot(svg, 1200, 630, path.join(OUT, 'og', f.replace(/\.svg$/, '.png')));
  record[f.replace(/\.svg$/, '')] = createHash('sha256').update(svg, 'utf8').digest('base64');
}
await writeFile(path.join(ROOT, 'src', 'og-rendered.json'), `${JSON.stringify(record, null, 2)}\n`);

// App icons: the mark on a padded tile (light palette; no media queries in raster icons).
const icon = (size, radius) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}"><rect width="32" height="32" rx="${radius}" fill="#131312"/><g transform="translate(4 4) scale(.75)"><path d="M8 22.5V9.5l5.5 7.5L19 9.5v13" fill="none" stroke="#F4F2ED" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><rect x="21.75" y="19.75" width="2.75" height="2.75" fill="#FF6B45"/></g></svg>`;
await shot(icon(180, 0), 180, 180, path.join(OUT, 'apple-touch-icon.png'));
await shot(icon(192, 7), 192, 192, path.join(OUT, 'icon-192.png'));
await shot(icon(512, 7), 512, 512, path.join(OUT, 'icon-512.png'));

await rm(work, { recursive: true, force: true });
console.log('Done. Re-run `node build.mjs` to copy them into dist/.');
