#!/usr/bin/env node
/**
 * build.mjs — zero-dependency static site generator (Node >= 22).
 *
 *   node build.mjs
 *
 * Reads  src/template.html, src/404.html, src/partials/*.html, src/styles.css,
 *        src/head.js, src/app.js, src/og.svg, src/static/**,
 *        content/site.json and content/<lang>.json
 * Writes dist/ — one fully pre-rendered page per language plus 404, robots,
 *        sitemap, manifest, favicon, social cards and .nojekyll.
 *
 * The build fails loudly (exit code 1) on any content or output problem.
 */
import { readFile, writeFile, mkdir, rm, readdir, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const CONTENT = path.join(ROOT, 'content');
const DIST = path.join(ROOT, 'dist');

class BuildError extends Error {}
const fail = (msg) => { throw new BuildError(msg); };

/* ------------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------------ */
const escapeHtml = (v) => String(v)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const shortHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const r1 = (n) => Math.round(n * 10) / 10;
const pad2 = (n) => String(n).padStart(2, '0');

async function readText(rel) {
  const file = path.join(ROOT, rel);
  try { return await readFile(file, 'utf8'); } catch { fail(`Missing file: ${rel}`); }
}
async function readJSON(rel) {
  const txt = await readText(rel);
  try { return JSON.parse(txt); } catch (e) { fail(`Invalid JSON in ${rel}: ${e.message}`); }
}
async function write(rel, data) {
  const file = path.join(DIST, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  return file;
}
async function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Tiny template engine
 *   {{path}}             escaped output (missing value = build error)
 *   {{path | rich}}      escaped, then *text* -> <em>text</em>
 *   {{path | title}}     escaped, trailing full stop wrapped in <span class="stop">
 *   {{path | url}}       encodeURIComponent
 *   {{{path}}}           raw output
 *   {{#if path}}…{{else}}…{{/if}}   {{#unless path}}…{{/unless}}
 *   {{#each path}}…{{/each}}        this, @index, @num (01…), @first, @last, @root
 *   {{> partial}}        src/partials/partial.html with the current scope
 *   {{! comment }}
 * ------------------------------------------------------------------------ */
function compile(src, name) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  const target = () => {
    const n = stack[stack.length - 1];
    return n.inElse ? n.alt : n.children;
  };
  const re = /\{\{\{\s*([\s\S]+?)\s*\}\}\}|\{\{\s*([\s\S]+?)\s*\}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) target().push({ type: 'text', value: src.slice(last, m.index) });
    last = re.lastIndex;
    if (m[1] !== undefined) { target().push({ type: 'raw', expr: m[1] }); continue; }
    const tag = m[2];
    if (tag.startsWith('!')) continue;
    if (tag.startsWith('#if ') || tag.startsWith('#unless ') || tag.startsWith('#each ')) {
      const kind = tag.slice(1, tag.indexOf(' '));
      const node = { type: kind, expr: tag.slice(kind.length + 2).trim(), children: [], alt: [], inElse: false };
      target().push(node);
      stack.push(node);
    } else if (tag === 'else') {
      const node = stack[stack.length - 1];
      if (node.type !== 'if' && node.type !== 'unless') fail(`${name}: {{else}} outside {{#if}}`);
      node.inElse = true;
    } else if (tag.startsWith('/')) {
      const kind = tag.slice(1).trim();
      const node = stack.pop();
      if (!node || node.type !== kind) fail(`${name}: unexpected {{/${kind}}}`);
    } else if (tag.startsWith('>')) {
      target().push({ type: 'partial', name: tag.slice(1).trim() });
    } else {
      const [expr, ...filters] = tag.split('|').map((s) => s.trim());
      target().push({ type: 'var', expr, filters });
    }
  }
  if (last < src.length) target().push({ type: 'text', value: src.slice(last) });
  if (stack.length !== 1) fail(`${name}: unclosed {{#${stack[stack.length - 1].type}}}`);
  return root.children;
}

function lookup(expr, scope, name, strict) {
  const resolvePath = (obj, parts) => {
    let cur = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object' || !(p in cur)) return undefined;
      cur = cur[p];
    }
    return cur;
  };
  let value;
  if (expr === 'this') value = scope.data;
  else if (expr.startsWith('this.')) value = resolvePath(scope.data, expr.slice(5).split('.'));
  else if (expr.startsWith('@root.')) {
    let s = scope; while (s.parent) s = s.parent;
    value = resolvePath(s.data, expr.slice(6).split('.'));
  } else if (expr.startsWith('@')) {
    for (let s = scope; s; s = s.parent) if (s.locals && expr in s.locals) { value = s.locals[expr]; break; }
  } else {
    const parts = expr.split('.');
    for (let s = scope; s; s = s.parent) {
      if (s.data && typeof s.data === 'object' && parts[0] in s.data) { value = resolvePath(s.data, parts); break; }
    }
  }
  if (strict && (value === undefined || value === null || typeof value === 'object')) {
    fail(`Template ${name}: "{{${expr}}}" ${value == null ? 'is missing' : 'is not a printable value'}`);
  }
  return value;
}

const FILTERS = {
  rich: (s) => escapeHtml(s).replace(/\*([^*]+)\*/g, '<em>$1</em>'),
  title: (s) => escapeHtml(s).replace(/([.。])$/, '<span class="stop">$1</span>'),
  url: (s) => encodeURIComponent(s),
};

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

function makeRenderer(partialSources) {
  const cache = new Map();
  const get = (name, src) => {
    if (!cache.has(name)) cache.set(name, compile(src, name));
    return cache.get(name);
  };
  const run = (nodes, scope, name) => {
    let out = '';
    for (const n of nodes) {
      switch (n.type) {
        case 'text': out += n.value; break;
        case 'raw': out += String(lookup(n.expr, scope, name, true)); break;
        case 'var': {
          const v = lookup(n.expr, scope, name, true);
          if (!n.filters.length) { out += escapeHtml(v); break; }
          let s = v;
          for (const f of n.filters) {
            if (!FILTERS[f]) fail(`Template ${name}: unknown filter "${f}"`);
            s = FILTERS[f](s);
          }
          out += s;
          break;
        }
        case 'if':
        case 'unless': {
          let cond = truthy(lookup(n.expr, scope, name, false));
          if (n.type === 'unless') cond = !cond;
          out += run(cond ? n.children : n.alt, scope, name);
          break;
        }
        case 'each': {
          const list = lookup(n.expr, scope, name, false);
          if (list == null) fail(`Template ${name}: {{#each ${n.expr}}} is missing`);
          if (!Array.isArray(list)) fail(`Template ${name}: {{#each ${n.expr}}} is not an array`);
          list.forEach((item, i) => {
            out += run(n.children, {
              data: item,
              parent: scope,
              locals: { '@index': i, '@num': pad2(i + 1), '@first': i === 0, '@last': i === list.length - 1 },
            }, name);
          });
          break;
        }
        case 'partial': {
          const src = partialSources[n.name];
          if (src === undefined) fail(`Template ${name}: unknown partial "${n.name}"`);
          out += run(get(`partials/${n.name}`, src), scope, `partials/${n.name}.html`);
          break;
        }
        default: fail(`Template ${name}: unknown node ${n.type}`);
      }
    }
    return out;
  };
  return (src, data, name) => run(get(name, src), { data, parent: null, locals: {} }, name);
}

/* ------------------------------------------------------------------------ *
 * Content validation
 * ------------------------------------------------------------------------ */
function flatten(obj, prefix = '', out = new Map()) {
  if (Array.isArray(obj)) {
    if (!obj.length) out.set(`${prefix}[]`, '');
    obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (!keys.length) out.set(`${prefix}{}`, '');
    for (const k of keys) flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, obj);
  }
  return out;
}

function checkLanguageFiles(dicts, defaultCode) {
  const flat = Object.fromEntries(Object.entries(dicts).map(([c, d]) => [c, flatten(d)]));
  const ref = flat[defaultCode];
  const problems = [];
  for (const [code, map] of Object.entries(flat)) {
    if (code !== defaultCode) {
      const missing = [...ref.keys()].filter((k) => !map.has(k));
      const extra = [...map.keys()].filter((k) => !ref.has(k));
      if (missing.length) problems.push(`content/${code}.json is missing ${missing.length} key(s):\n    - ${missing.join('\n    - ')}`);
      if (extra.length) problems.push(`content/${code}.json has ${extra.length} key(s) not in ${defaultCode}.json:\n    - ${extra.join('\n    - ')}`);
    }
    for (const [k, v] of map) {
      if (k.endsWith('[]') || k.endsWith('{}')) continue;
      if (typeof v !== 'string') problems.push(`content/${code}.json: "${k}" must be a string (got ${typeof v})`);
      else if (!v.trim()) problems.push(`content/${code}.json: "${k}" is empty`);
    }
  }
  if (problems.length) fail(`Language files do not have identical, complete key sets:\n  ${problems.join('\n  ')}`);
}

/*
 * Guard against shipping a page in the wrong language: a dictionary copied from another
 * language, a placeholder title, or (for CJK locales) text that is still in English.
 * Keys listed here are brand or product names that stay the same in every language.
 */
const SAME_IN_EVERY_LANGUAGE = new Set([
  'capabilities.items.powerPlatform.title',
  'capabilities.items.dynamics.title',
  'certificates.issuer',
  'contact.whatsapp',
  'contact.github',
  'showcase.figure.curve',
  'showcase.figure.hero',
]);
const CJK = /[㐀-鿿豈-﫿]/;

function checkTranslations(dicts, site) {
  const codes = Object.keys(dicts);
  const flat = Object.fromEntries(codes.map((c) => [c, flatten(dicts[c])]));
  const problems = [];
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      const [a, b] = [codes[i], codes[j]];
      if (JSON.stringify(dicts[a]) === JSON.stringify(dicts[b])) problems.push(`content/${a}.json and content/${b}.json are identical — one of them is not translated`);
      else if (dicts[a].meta.title === dicts[b].meta.title) problems.push(`meta.title is the same in ${a}.json and ${b}.json — each language needs its own title`);
    }
  }
  for (const l of site.languages) {
    if (!/^(zh|ja|ko)\b/i.test(l.htmlLang)) continue;
    const map = flat[l.code];
    if (!CJK.test(dicts[l.code].meta.title)) problems.push(`content/${l.code}.json: meta.title has no ${l.htmlLang} characters`);
    const untranslated = [];
    for (const [k, v] of map) {
      if (typeof v !== 'string' || CJK.test(v) || !/[A-Za-z]{2}/.test(v) || SAME_IN_EVERY_LANGUAGE.has(k)) continue;
      if (codes.some((c) => c !== l.code && flat[c].get(k) === v)) untranslated.push(`${k}: "${v}"`);
    }
    if (untranslated.length) problems.push(`content/${l.code}.json has ${untranslated.length} string(s) copied untranslated from another language:\n    - ${untranslated.join('\n    - ')}\n    (if a value really is the same in every language, add its key to SAME_IN_EVERY_LANGUAGE in build.mjs)`);
  }
  if (problems.length) fail(`Translation check failed:\n  - ${problems.join('\n  - ')}`);
}

function validateSite(site, dicts) {
  const errs = [];
  if (!/^https:\/\/[^/]+$/.test(site.url || '')) errs.push('site.url must be an https origin without trailing slash');
  if (!site.name) errs.push('site.name is required');
  const codes = (site.languages || []).map((l) => l.code);
  if (!codes.includes(site.defaultLanguage)) errs.push('site.defaultLanguage must be one of site.languages');
  for (const l of site.languages || []) {
    if (!/^\/([a-z-]+\/)?$/.test(l.path)) errs.push(`language ${l.code}: path must look like "/" or "/xx/"`);
    if (l.code === site.defaultLanguage && l.path !== '/') errs.push('the default language must live at "/"');
    for (const k of ['htmlLang', 'hreflang', 'ogLocale', 'native', 'short']) if (!l[k]) errs.push(`language ${l.code}: "${k}" is required`);
  }
  const c = site.contact || {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || '')) errs.push('contact.email is missing or invalid');
  if (typeof c.phone !== 'string') errs.push('contact.phone must be a string ("" when not provided)');
  else if (c.phone.trim()) {
    const digits = c.phone.replace(/[\s().+-]/g, '');
    if (!/^\d{8,15}$/.test(digits)) errs.push('contact.phone must be an international number: country code + number, 8–15 digits (e.g. "+34 600 000 000")');
  }
  if (!/^https:\/\//.test(site.links?.github || '')) errs.push('links.github must be an https URL');
  if (!Array.isArray(site.certificates)) errs.push('certificates must be an array ([] when empty)');
  else site.certificates.forEach((cert, i) => {
    const where = `certificates[${i}]`;
    if (!cert || typeof cert !== 'object') { errs.push(`${where} must be an object`); return; }
    const allowed = new Set(['name', 'date', 'url', 'code']);
    for (const k of Object.keys(cert)) if (!allowed.has(k)) errs.push(`${where}: unknown field "${k}" (allowed: name, code, date, url)`);
    if (!cert.name || typeof cert.name !== 'string') errs.push(`${where}: "name" is required`);
    if (cert.date !== undefined && cert.date !== '' && !/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(cert.date)) errs.push(`${where}: "date" must be "YYYY-MM" or "YYYY-MM-DD" (or omitted)`);
    if (cert.url !== undefined && cert.url !== '' && !/^https:\/\//.test(cert.url)) errs.push(`${where}: "url" must be an https URL (or omitted)`);
  });
  for (const id of site.capabilities || []) {
    for (const [code, d] of Object.entries(dicts)) if (!d.capabilities?.items?.[id]) errs.push(`content/${code}.json: capabilities.items.${id} is missing`);
  }
  for (const g of site.project?.stack || []) {
    for (const [code, d] of Object.entries(dicts)) if (!d.showcase?.stackGroups?.[g.group]) errs.push(`content/${code}.json: showcase.stackGroups.${g.group} is missing`);
  }
  if (!/^https:\/\//.test(site.project?.url || '')) errs.push('project.url must be an https URL');
  if (errs.length) fail(`content/site.json has problems:\n  - ${errs.join('\n  - ')}`);
}

/* ------------------------------------------------------------------------ *
 * Derived data
 * ------------------------------------------------------------------------ */
function icmGeometry() {
  // Illustrative only: nine example stacks (seat order, Hero first; sum = 100 %)
  // spread evenly enough that the points march along an example ICM-shaped curve.
  const cx = 300, cy = 200;
  const table = { cx, cy, rx: 188, ry: 98, rimX: 204, rimY: 114, railX: 164, railY: 78 };
  const shares = [0.12, 0.07, 0.30, 0.05, 0.09, 0.03, 0.16, 0.10, 0.08];
  const total = shares.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-9) fail(`icmGeometry: example stacks must sum to 100 % (got ${total})`);
  const maxShare = Math.max(...shares);
  const leaderIdx = shares.indexOf(maxShare);
  const seats = shares.map((s, i) => {
    const a = ((90 + i * 40) * Math.PI) / 180;
    // Seat size encodes stack size (area ∝ chips), so the big stack on the table is the right-most point.
    const r = r1(10 + 14 * Math.sqrt(s / maxShare));
    return { cx: r1(cx + 252 * Math.cos(a)), cy: r1(cy + 140 * Math.sin(a)), r, core: r1(r * 0.42), hero: i === 0, leader: i === leaderIdx };
  });
  const pot = [10, 3, -4].map((d) => ({ y: cy + d }));
  const dSeat = seats[8];
  const dealer = { x: r1(cx + (dSeat.cx - cx) * 0.6), y: r1(cy + (dSeat.cy - cy) * 0.6) };
  dealer.ty = r1(dealer.y + 4.3);

  const plot = { x0: 84, x1: 568, y0: 500, y1: 716 };
  plot.tickYx = plot.x0 - 10;
  plot.tickXy = plot.y1 + 24;
  const D = 0.4;
  // Concave example curve: small stacks are worth more than their chip share, the chip leader less.
  const f = (s) => 0.28 * (1 - Math.exp(-s / 0.1));
  const X = (s) => r1(plot.x0 + (s / D) * (plot.x1 - plot.x0));
  const Y = (v) => r1(plot.y1 - (v / D) * (plot.y1 - plot.y0));
  const steps = [0, 0.1, 0.2, 0.3, 0.4];
  const gridY = steps.map((v) => ({ y: Y(v), ty: r1(Y(v) + 4), label: `${Math.round(v * 100)}%` }));
  const gridX = steps.map((s) => ({ x: X(s), label: `${Math.round(s * 100)}%` }));
  const samples = Array.from({ length: 41 }, (_, i) => i / 100);
  const curvePts = samples.map((s) => `${X(s)} ${Y(f(s))}`);
  const curve = `M${curvePts.join('L')}`;
  const diag = `M${X(0)} ${Y(0)}L${X(D)} ${Y(D)}`;
  const area = `M${curvePts.join('L')}L${X(D)} ${Y(D)}Z`;
  const points = shares.map((s, i) => ({ x: X(s), y: Y(f(s)), hero: i === 0, leader: i === leaderIdx }));
  const hp = points[0];
  const heroPoint = { x: hp.x, y: hp.y, lx: r1(hp.x - 16), ly: r1(hp.y - 20) };
  const heroGuide = `M${hp.x} ${plot.y1}V${hp.y}H${plot.x0}`;
  const labels = {
    diagX: plot.x1 - 4, diagY: plot.y0 - 12,
    curveX: plot.x1 - 4, curveY: r1(Y(f(D)) + 24),
    axisXx: (plot.x0 + plot.x1) / 2, axisXy: plot.y1 + 54,
    axisYx: 26, axisYy: (plot.y0 + plot.y1) / 2,
  };
  const heroSeat = { cx: seats[0].cx, labelY: r1(seats[0].cy + seats[0].r + 30) };
  return { table, seats, pot, dealer, heroSeat, plot, gridY, gridX, curve, diag, area, points, heroPoint, heroGuide, labels };
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}
function minifyInlineScript(js) {
  return js.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '').replace(/\s+/g, ' ').trim();
}

function formatCertDate(date, locale) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d || 1));
  const opts = d ? { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' } : { year: 'numeric', month: 'long', timeZone: 'UTC' };
  return new Intl.DateTimeFormat(locale, opts).format(dt);
}

/* ------------------------------------------------------------------------ *
 * Output verification
 * ------------------------------------------------------------------------ */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function checkWellFormed(markup, file, { xml = false } = {}) {
  const stack = [];
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = re.exec(markup))) {
    if (!m[2]) continue;
    const name = xml ? m[2] : m[2].toLowerCase();
    const line = markup.slice(0, m.index).split('\n').length;
    if (m[1]) {
      const open = stack.pop();
      if (!open) fail(`${file}:${line}: closing </${name}> without an open element`);
      if (open.name !== name) fail(`${file}:${line}: </${name}> closes <${open.name}> opened on line ${open.line}`);
    } else if (m[4] || (!xml && VOID.has(name))) {
      continue;
    } else {
      stack.push({ name, line });
      if (!xml && (name === 'script' || name === 'style')) {
        const end = markup.indexOf(`</${name}`, re.lastIndex);
        if (end < 0) fail(`${file}: <${name}> on line ${line} is never closed`);
        re.lastIndex = end;
      }
    }
  }
  if (stack.length) fail(`${file}: unclosed <${stack[stack.length - 1].name}> from line ${stack[stack.length - 1].line}`);
}

function distPathFor(urlPath) {
  const clean = decodeURI(urlPath.split(/[?#]/)[0]);
  return path.join(DIST, clean.endsWith('/') ? `${clean}index.html` : clean);
}

/*
 * Recompute the CSP hashes from the final HTML on disk. If an inline <script> or <style>
 * changed after the policy was generated (a hand edit, a template mismatch, the 404 page…),
 * the browser would silently drop it, so the build fails instead.
 */
function verifyCsp(html, rel) {
  const metaRe = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/;
  const meta = metaRe.exec(html);
  if (!meta) fail(`${rel}: Content-Security-Policy <meta> is missing`);
  const policy = meta[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const directives = Object.fromEntries(policy.split(';').map((d) => d.trim().split(/\s+/)).filter((p) => p[0]).map(([k, ...v]) => [k, v]));
  const firstInline = html.search(/<(script|style)\b/);
  if (firstInline !== -1 && firstInline < meta.index) fail(`${rel}: the CSP <meta> must come before the first <script>/<style>`);
  const check = (kind, body) => {
    const token = `'sha256-${sha256(body)}'`;
    const list = directives[`${kind}-src`] || [];
    if (!list.includes(token)) fail(`${rel}: inline <${kind}> (${body.length} bytes) is not allowed by the CSP — expected ${token} in ${kind}-src`);
  };
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1] || '';
    if (/\ssrc=/.test(attrs) || /type="application\/ld\+json"/.test(attrs)) continue;
    check('script', m[2]);
  }
  for (const m of html.matchAll(/<style(\s[^>]*)?>([\s\S]*?)<\/style>/g)) check('style', m[2]);
  if (/<[a-z][^>]*\sstyle="/i.test(html)) fail(`${rel}: style="" attributes are blocked by the CSP (style-src uses hashes only)`);
  if (/<[a-z][^>]*\son[a-z]+="/i.test(html)) fail(`${rel}: inline event handlers (on…="") are blocked by the CSP`);
}

function verifyHtml(html, rel, siteUrl) {
  checkWellFormed(html, rel);
  verifyCsp(html, rel);
  const ids = new Map();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.set(m[1], (ids.get(m[1]) || 0) + 1);
  const dups = [...ids].filter(([, n]) => n > 1).map(([id]) => id);
  if (dups.length) fail(`${rel}: duplicate id(s): ${dups.join(', ')}`);
  for (const m of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
    const [, attr, url] = m;
    if (url.startsWith('#')) {
      if (url.length > 1 && !ids.has(url.slice(1))) fail(`${rel}: ${attr}="${url}" points to a missing id`);
    } else if (url.startsWith('/')) {
      if (url.startsWith('//')) fail(`${rel}: protocol-relative URL ${url}`);
      if (!existsSync(distPathFor(url))) fail(`${rel}: ${attr}="${url}" does not exist in dist/`);
    } else if (attr === 'src') {
      fail(`${rel}: src="${url}" must be a root-absolute local path (no external requests)`);
    } else if (!/^(https:|mailto:|tel:)/.test(url)) {
      fail(`${rel}: unexpected href "${url}" — use root-absolute paths ("/en/") or full https URLs`);
    }
  }
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = m[0];
    const rel2 = /rel="([^"]+)"/.exec(tag)?.[1] || '';
    const href = /href="([^"]+)"/.exec(tag)?.[1] || '';
    if (/^https?:/.test(href) && !['canonical', 'alternate'].includes(rel2)) fail(`${rel}: <link rel="${rel2}"> loads an external resource`);
    if (['canonical', 'alternate'].includes(rel2) && !href.startsWith(`${siteUrl}/`)) fail(`${rel}: ${rel2} must point to ${siteUrl}`);
  }
}

/* ------------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------------ */
async function build() {
  const t0 = performance.now();
  const site = await readJSON('content/site.json');
  const langs = site.languages;
  const dicts = {};
  for (const l of langs) dicts[l.code] = await readJSON(`content/${l.code}.json`);
  checkLanguageFiles(dicts, site.defaultLanguage);
  validateSite(site, dicts);
  checkTranslations(dicts, site);

  // Sources
  const partials = {};
  for (const f of await readdir(path.join(SRC, 'partials'))) {
    if (f.endsWith('.html')) partials[f.slice(0, -5)] = await readFile(path.join(SRC, 'partials', f), 'utf8');
  }
  const render = makeRenderer(partials);
  const pageTpl = await readText('src/template.html');
  const notFoundTpl = await readText('src/404.html');
  const ogTpl = await readText('src/og.svg');
  const css = minifyCss(await readText('src/styles.css'));
  const config = { d: site.defaultLanguage, p: Object.fromEntries(langs.map((l) => [l.code, l.path])) };
  const headScript = minifyInlineScript((await readText('src/head.js')).replace('__CONFIG__', JSON.stringify(config)));
  const appJs = await readText('src/app.js');

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // Static files (favicon, pre-rendered PNGs, …)
  const staticDir = path.join(SRC, 'static');
  for (const file of await walk(staticDir)) {
    const rel = path.relative(staticDir, file);
    await mkdir(path.dirname(path.join(DIST, rel)), { recursive: true });
    await copyFile(file, path.join(DIST, rel));
  }
  const has = (rel) => existsSync(path.join(DIST, rel));

  const jsName = `assets/app.${shortHash(appJs)}.js`;
  await write(jsName, appJs);

  const csp = [
    "default-src 'none'",
    `script-src 'self' 'sha256-${sha256(headScript)}'`,
    `style-src 'sha256-${sha256(css)}'`,
    "img-src 'self' data:",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const assets = { css, headScript, csp, js: `/${jsName}`, hasTouchIcon: has('apple-touch-icon.png') };

  const base = site.url;
  const year = new Date().getUTCFullYear();
  const [first, ...rest] = site.name.split(' ');
  const nameParts = { first, last: rest.join(' ') };
  const icm = icmGeometry();
  const digits = site.contact.phone.replace(/\D/g, '');
  const hasPhone = digits.length > 0;
  const certsSorted = site.certificates.every((c) => c.date) ? [...site.certificates].sort((a, b) => b.date.localeCompare(a.date)) : [...site.certificates];
  const hasCerts = certsSorted.length > 0;
  const alternates = [
    ...langs.map((l) => ({ hreflang: l.hreflang, href: `${base}${l.path}` })),
    { hreflang: 'x-default', href: `${base}/` },
  ];

  // Social cards (SVG source for each language)
  const guides = Array.from({ length: 13 }, (_, i) => {
    const x = r1(72 + (i * 1056) / 12);
    return `<line x1="${x}" y1="0" x2="${x}" y2="630"/>`;
  }).join('');
  // tools/render-images.mjs records the hash of each SVG it rasterised, so a PNG that no
  // longer matches the current content (e.g. after a translation change) is reported.
  const ogRecordFile = path.join(SRC, 'og-rendered.json');
  const ogRecord = existsSync(ogRecordFile) ? JSON.parse(await readFile(ogRecordFile, 'utf8')) : {};
  const ogWarnings = [];
  for (const l of langs) {
    const t = dicts[l.code];
    const og = {
      host: new URL(base).host.toUpperCase(),
      first: nameParts.first, last: nameParts.last,
      roles: t.hero.roles.join('  ·  ').toUpperCase(),
      guides,
    };
    const svg = render(ogTpl, { og }, 'og.svg');
    checkWellFormed(svg, `og/${l.code}.svg`, { xml: true });
    await write(`og/${l.code}.svg`, svg);
    if (!has(`og/${l.code}.png`)) {
      // Social crawlers do not accept SVG og:images, so CI refuses to deploy without the PNGs.
      if (process.env.CI) fail(`src/static/og/${l.code}.png is missing — run \`node build.mjs && node tools/render-images.mjs && node build.mjs\` locally and commit the PNGs`);
      ogWarnings.push(`og/${l.code}.png is missing — the page falls back to another card`);
    } else if (ogRecord[l.code] !== sha256(svg)) {
      ogWarnings.push(`og/${l.code}.png is out of date with the current content — run tools/render-images.mjs`);
    }
  }
  const ogFor = (code) => {
    for (const c of [code, site.defaultLanguage]) if (has(`og/${c}.png`)) return { url: `${base}/og/${c}.png`, type: 'image/png' };
    return { url: `${base}/og/${code}.svg`, type: 'image/svg+xml' };
  };

  const written = [];
  for (const l of langs) {
    const t = dicts[l.code];
    const canonical = `${base}${l.path}`;
    const navIds = ['capabilities', 'work', ...(hasCerts ? ['certificates'] : []), 'security', 'approach', 'contact'];
    const nav = navIds.map((id, i) => ({ id, label: t.nav[id], num: pad2(i + 1) }));
    const sec = Object.fromEntries(nav.map((n) => [n.id, n.num]));
    const mail = (subject) => `mailto:${site.contact.email}?subject=${encodeURIComponent(subject)}`;
    const [emailUser, emailDomain] = site.contact.email.split('@');
    const contact = {
      emailHtml: `${escapeHtml(emailUser)}<wbr>@${escapeHtml(emailDomain)}`,
      mailto: mail(t.contact.emailSubject),
      mailtoSecurity: mail(t.security.emailSubject),
      hasPhone,
      whatsapp: hasPhone ? `https://wa.me/${digits}?text=${encodeURIComponent(t.contact.whatsappText).replace(/'/g, '%27')}` : '',
      tel: hasPhone ? `tel:+${digits}` : '',
      phoneDisplay: hasPhone ? (site.contact.phoneDisplay || `+${digits}`) : '',
    };
    const certs = certsSorted.map((c) => ({ name: c.name, code: c.code || '', date: c.date || '', url: c.url || '', dateLabel: c.date ? formatCertDate(c.date, l.htmlLang) : '' }));
    const og = ogFor(l.code);
    const headline = t.hero.roles.join(' · ');
    const person = {
      '@type': 'Person',
      '@id': `${base}/#person`,
      name: site.name,
      jobTitle: headline,
      description: t.meta.description,
      url: `${base}/`,
      email: `mailto:${site.contact.email}`,
      sameAs: [site.links.github],
      knowsAbout: site.capabilities.map((id) => t.capabilities.items[id].title),
      ...(hasPhone ? { telephone: `+${digits}` } : {}),
      ...(hasCerts ? {
        hasCredential: certs.map((c) => ({
          '@type': 'EducationalOccupationalCredential',
          name: c.name,
          credentialCategory: 'certification',
          ...(c.date ? { dateCreated: c.date } : {}),
          recognizedBy: { '@type': 'Organization', name: 'Microsoft' },
          ...(c.url ? { url: c.url } : {}),
        })),
      } : {}),
    };
    const jsonld = {
      '@context': 'https://schema.org',
      '@graph': [
        person,
        { '@type': 'WebSite', '@id': `${base}/#website`, url: `${base}/`, name: site.name, inLanguage: langs.map((x) => x.htmlLang), publisher: { '@id': `${base}/#person` } },
        { '@type': 'ProfilePage', '@id': `${canonical}#webpage`, url: canonical, name: t.meta.title, description: t.meta.description, inLanguage: l.htmlLang, isPartOf: { '@id': `${base}/#website` }, mainEntity: { '@id': `${base}/#person` } },
        { '@type': 'Service', '@id': `${base}/#security-assessment`, name: t.security.title.replace(/[.。]$/, ''), description: `${t.security.intro} ${t.security.promiseBody}`, provider: { '@id': `${base}/#person` }, url: `${canonical}#security` },
        { '@type': 'SoftwareApplication', '@id': `${site.project.url}/#app`, name: site.project.name, url: site.project.url, description: t.showcase.tagline, applicationCategory: 'EducationalApplication', isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' }, author: { '@id': `${base}/#person` } },
      ],
    };
    const ctx = {
      lang: l,
      t,
      site,
      langs: langs.map((x) => ({ ...x, current: x.code === l.code })),
      nav,
      sec,
      nameParts,
      capabilities: site.capabilities.map((id) => ({ id, ...t.capabilities.items[id] })),
      stack: site.project.stack.map((g) => ({ label: t.showcase.stackGroups[g.group], items: g.items })),
      certs,
      hasCerts,
      contact,
      icm,
      year,
      alternates,
      ogAlternateLocales: langs.filter((x) => x.code !== l.code).map((x) => x.ogLocale),
      assets,
      page: {
        canonical,
        ogImage: og.url,
        ogImageType: og.type,
        jsonld: JSON.stringify(jsonld).replace(/</g, '\\u003c'),
      },
    };
    const html = render(pageTpl, ctx, 'template.html');
    const rel = l.path === '/' ? 'index.html' : `${l.path.slice(1)}index.html`;
    await write(rel, html);
    written.push(rel);
  }

  // 404 — served by GitHub Pages for any missing path, at any depth: root-absolute URLs only.
  const def = langs.find((l) => l.code === site.defaultLanguage);
  const nf = render(notFoundTpl, {
    lang: def,
    t: dicts[def.code],
    site,
    assets,
    notFoundLinks: langs.map((l) => ({ ...l, home: dicts[l.code].notFound.home })),
  }, '404.html');
  await write('404.html', nf);
  written.push('404.html');

  // robots, sitemap, manifest, .nojekyll
  // No <lastmod>: the build date changes on every deploy whether or not the content did,
  // and search engines ignore lastmod values they cannot trust.
  await write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`);
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...langs.map((l) => [
      '  <url>',
      `    <loc>${base}${l.path}</loc>`,
      ...alternates.map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}"/>`),
      '  </url>',
    ].join('\n')),
    '</urlset>',
    '',
  ].join('\n');
  checkWellFormed(sitemap, 'sitemap.xml', { xml: true });
  await write('sitemap.xml', sitemap);

  const icons = [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }];
  for (const s of [192, 512]) if (has(`icon-${s}.png`)) icons.push({ src: `/icon-${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'any' });
  const manifest = {
    name: site.name,
    short_name: site.name.split(' ')[0],
    description: dicts[def.code].meta.description,
    lang: def.htmlLang,
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // One pair, matching the light <meta name="theme-color"> (the manifest has no dark variant).
    background_color: '#F4F2ED',
    theme_color: '#F4F2ED',
    icons,
  };
  await write('site.webmanifest', `${JSON.stringify(manifest, null, 2)}\n`);
  await write('.nojekyll', '');

  // Verify every page after everything is on disk (links resolve against dist/).
  for (const rel of written) verifyHtml(await readFile(path.join(DIST, rel), 'utf8'), rel, base);

  // Report
  const files = await walk(DIST);
  let total = 0;
  const rows = [];
  for (const f of files.sort()) {
    const buf = await readFile(f);
    total += buf.length;
    const gz = /\.(html|js|svg|xml|txt|webmanifest)$/.test(f) ? gzipSync(buf).length : buf.length;
    rows.push(`  ${path.relative(DIST, f).padEnd(30)} ${(buf.length / 1024).toFixed(1).padStart(7)} KB  ${(gz / 1024).toFixed(1).padStart(6)} KB gz`);
  }
  console.log(`Built ${files.length} files in ${Math.round(performance.now() - t0)} ms → dist/`);
  console.log(rows.join('\n'));
  console.log(`  certificates: ${hasCerts ? certsSorted.length : 'none (section omitted)'} · phone/WhatsApp: ${hasPhone ? 'shown' : 'not set (buttons omitted)'}`);
  for (const w of ogWarnings) console.warn(process.env.GITHUB_ACTIONS ? `::warning::${w}` : `  warning: ${w}`);
}

build().catch((err) => {
  if (err instanceof BuildError) {
    console.error(`\nBUILD FAILED\n${err.message}\n`);
  } else {
    console.error('\nBUILD FAILED (unexpected error)\n', err);
  }
  process.exit(1);
});
