# mehrdadabedin.github.io

Personal portfolio and capabilities catalogue of **Mehrdad Abedin** — Solution Architect · AI & Microsoft Technologies · Full-Stack Development.

Live at <https://mehrdadabedin.github.io/> in three languages:

| Language | URL |
| --- | --- |
| Español (default) | `/` |
| English | `/en/` |
| 简体中文 (zh-Hans) | `/zh/` |

It is a zero-dependency static site: one small Node script (`build.mjs`) turns the content files into fully pre-rendered HTML for each language. There is no framework, no npm install, no CDN, no web fonts, no analytics and no cookies. The pages make no requests to third parties.

## Build and preview

Requirements: Node.js 22 or newer.

```sh
node build.mjs                          # writes dist/
python3 -m http.server -d dist 8000     # then open http://localhost:8000/
# or: npx serve dist
```

The build fails with a clear message (exit code 1) when:

- `content/es.json`, `content/en.json` and `content/zh.json` do not have **identical key sets** (it lists every missing or extra key), or a text value is empty;
- a language file is not actually translated: two dictionaries are identical, two languages share the same `meta.title`, or `zh.json` contains a string copied unchanged from another language (brand names that never change are allow-listed in `SAME_IN_EVERY_LANGUAGE` in `build.mjs`);
- `content/site.json` is malformed (bad e-mail, phone, certificate date, URL…);
- a template refers to a value that does not exist;
- the generated HTML is not well-formed, has duplicate ids, or contains a link to a page, file or `#anchor` that does not exist, or any external resource;
- an inline `<script>`/`<style>` in any of the four pages (including `404.html`) does not match the hashes in its Content-Security-Policy — the hashes are recomputed from the final HTML on disk;
- in CI (`CI` is set, as on GitHub Actions), a pre-rendered `src/static/og/<lang>.png` social card is missing.

Deployment is automatic: every push to `main` runs `.github/workflows/pages.yml`, which builds with Node 22 and publishes `dist/` to GitHub Pages. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.

## Project layout

```
build.mjs               the generator (template engine, validation, output checks)
content/
  site.json             language-neutral data: contact, links, certificates, project stack
  es.json               all Spanish copy (primary voice)
  en.json               all English copy
  zh.json               all Simplified Chinese copy
src/
  template.html         page shell
  404.html              not-found page (works at any URL depth)
  partials/*.html       header, hero, sections, footer, icon sprite, figure
  styles.css            the whole design system (inlined into each page)
  head.js               tiny inline script: theme without flash + remembered language
  app.js                progressive enhancement (menu, theme toggle, reveals, copy e-mail)
  og.svg                social card design (rendered per language to dist/og/<lang>.svg)
  static/               copied as-is: favicon.svg, og/<lang>.png, app icons
  og-rendered.json      written by tools/render-images.mjs: which SVG each og PNG was rendered from
tools/render-images.mjs optional: re-renders the PNG social cards and icons with local Chrome
.github/workflows/pages.yml
```

## Editing content

All visible text lives in `content/<lang>.json`; the three files must keep exactly the same keys. When you add or change a string, update all three files. Text in `hero.lead` may use `*asterisks*` for the accent italics.

### Adding the phone / WhatsApp number

WhatsApp and phone use the same number. While `contact.phone` is empty, both buttons are omitted. To show them, edit `content/site.json`:

```json
"contact": {
  "email": "abedin.mehrdad@proton.me",
  "phone": "+34 600 000 000",
  "phoneDisplay": "+34 600 000 000"
}
```

- `phone` — the full international number with country code. Spaces, `+`, dashes and brackets are ignored; 8–15 digits are required.
- `phoneDisplay` — optional, how the number is printed on the page. If empty, `+<digits>` is shown.

The build then renders a WhatsApp button (`https://wa.me/<digits>?text=…` with a greeting in the page's language, from `contact.whatsappText`) and a call button (`tel:+<digits>`), and adds `telephone` to the structured data.

### Adding Microsoft certifications

While `certificates` is an empty array, the certifications section and its navigation link are omitted entirely (section numbers re-flow automatically). To show them, add entries to `content/site.json`:

```jsonc
"certificates": [
  // Example only — replace with the real certifications:
  // {
  //   "name": "Microsoft Certified: <certification name>",
  //   "date": "2024-05",
  //   "url": "https://learn.microsoft.com/api/credentials/share/<your-credential-id>"
  // }
]
```

- `name` — required, exactly as Microsoft lists it.
- `code` — optional, the exam code shown on the card (e.g. `MB-700`).
- `date` — optional, `YYYY-MM` or `YYYY-MM-DD`; shown localised (e.g. "mayo de 2024" / "May 2024"). When every entry has a date they are sorted newest first; otherwise the order in the file is kept.
- `url` — optional, an `https://` verification link (Microsoft Learn credential share URL). When present, a "Verify" link is shown.

No other fields are accepted, so typos are caught by the build. (JSON does not allow comments — the commented example above is for illustration only; real entries are plain objects.)

## Social cards and icons

`build.mjs` writes an SVG social card per language to `dist/og/<lang>.svg`. Most social networks need PNG, so pre-rendered PNGs are committed in `src/static/og/` together with `apple-touch-icon.png` and `icon-192/512.png`; the build uses them when present. After changing the name, roles or card design, regenerate them with a locally installed Chrome/Chromium (no npm packages needed):

```sh
node build.mjs && node tools/render-images.mjs && node build.mjs
```

Set `CHROME=/path/to/chrome` if it is not found automatically. The script also records, in `src/og-rendered.json`, a hash of the SVG each PNG was made from; whenever the current content would produce a different card (for example after changing `hero.roles`), `build.mjs` prints a warning that the PNG is out of date. Commit the regenerated PNGs and `src/og-rendered.json` together.

## Language choice

Spanish is the default at `/`, and a first visit is never redirected: nothing is stored yet, and crawlers have no storage. The language switcher is a set of plain links that work without JavaScript. When a visitor explicitly picks English or Chinese, that choice is stored in `localStorage` (`lang`), and a later plain visit to `/` opens their language before first paint. The redirect is skipped for navigation within the site (so choosing "Español" always works and stores `es`), for URLs that carry a query string or a `#fragment` (shared deep links open as shared), and it uses `location.replace`, so the Back button never loops.

## Design notes

- **Palette:** warm paper `#F4F2ED` and ink `#131312`, with a single vermilion accent (`#B8401F` light, `#FF6B45` dark). Light and dark themes follow the system and can be overridden with the header toggle (stored in `localStorage`, applied before first paint).
- **Type:** system font stacks only — the platform's UI sans for display and text, a system serif italic for accents, and a system monospace for the catalogue labels; CJK fallbacks (PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC) for Chinese.
- **Accessibility:** skip link, landmarks, logical headings, visible focus rings, 44 px touch targets, `prefers-reduced-motion` respected, WCAG AA contrast in both themes, everything usable without JavaScript.
- **Privacy & security:** no cookies, analytics or third-party requests; a strict Content-Security-Policy (`default-src 'none'`, hashed inline script and style) is generated at build time and verified against the final HTML. Because GitHub Pages cannot send custom headers, the policy is delivered in a `<meta>` tag; `frame-ancestors` (clickjacking protection) cannot be set that way and is therefore not part of it.
- **Sitemap:** `sitemap.xml` lists the three pages with `hreflang` alternates and deliberately has no `<lastmod>` (a build date would change on every deploy and is ignored by search engines).

## SEO and machine-readable files

Generated by the build for each language (`/`, `/en/`, `/zh/`):

- `llms.txt` (also `llm.txt`) and `agent.txt` (also `agents.txt`) — plain-text summaries for LLMs and AI agents, built from the same content files. Their headings live under `machine` in `content/<lang>.json`.
- `site.webmanifest` — localised name and description.
- `sitemap-<lang>.xml`, listed in the `sitemap.xml` index and in `robots.txt`, each with `hreflang` alternates and the social image.
- A 1200×630 social card per language in `og/<lang>.png`.

`favicon.svg`, `icon-192.png` and a generated `favicon.ico` are shared by all languages.
