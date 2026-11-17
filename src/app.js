/* Progressive enhancement only. The site is fully usable without this file. */
(() => {
  'use strict';
  const d = document;
  const root = d.documentElement;
  const $ = (s, c = d) => c.querySelector(s);
  const $$ = (s, c = d) => Array.from(c.querySelectorAll(s));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: ignore */ } },
  };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');

  /* ---------- Theme ---------- */
  const themeBtns = $$('[data-theme-toggle]');
  const metaThemes = $$('meta[name="theme-color"]');
  const themeColors = { light: '#F4F2ED', dark: '#0E0E0D' };
  const currentTheme = () => root.getAttribute('data-theme') || (darkQuery.matches ? 'dark' : 'light');
  const syncTheme = () => {
    const t = currentTheme();
    themeBtns.forEach((b) => {
      b.setAttribute('aria-label', t === 'dark' ? b.dataset.labelLight : b.dataset.labelDark);
    });
    if (root.hasAttribute('data-theme')) metaThemes.forEach((m) => m.setAttribute('content', themeColors[t]));
  };
  themeBtns.forEach((b) => {
    b.hidden = false;
    b.addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.classList.add('theme-switching');
      root.setAttribute('data-theme', next);
      store.set('theme', next);
      syncTheme();
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
    });
  });
  darkQuery.addEventListener?.('change', syncTheme);
  syncTheme();

  /* ---------- Language: remember explicit choice ---------- */
  $$('a[data-lang]').forEach((a) => {
    a.addEventListener('click', () => store.set('lang', a.dataset.lang));
  });

  /* ---------- Mobile menu ---------- */
  const menuBtn = $('[data-menu-toggle]');
  const menu = $('[data-menu]');
  const mq = matchMedia('(max-width: 79.99em)');
  if (menuBtn && menu) {
    menuBtn.hidden = false;
    const outside = () => [$('main'), $('.site-footer'), $('.skip')].filter(Boolean);
    const setOpen = (open, { focus = true } = {}) => {
      root.toggleAttribute('data-menu-open', open);
      menuBtn.setAttribute('aria-expanded', String(open));
      menuBtn.setAttribute('aria-label', open ? menuBtn.dataset.labelClose : menuBtn.dataset.labelOpen);
      outside().forEach((el) => { el.inert = open; });
      if (open && focus) $('a', menu)?.focus({ preventScroll: true });
      else if (!open && focus) menuBtn.focus({ preventScroll: true });
    };
    menuBtn.addEventListener('click', () => setOpen(menuBtn.getAttribute('aria-expanded') !== 'true'));
    menu.addEventListener('click', (e) => {
      if (e.target.closest('a') && root.hasAttribute('data-menu-open')) setOpen(false, { focus: false });
    });
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root.hasAttribute('data-menu-open')) setOpen(false);
    });
    mq.addEventListener?.('change', () => { if (!mq.matches && root.hasAttribute('data-menu-open')) setOpen(false, { focus: false }); });
  }

  /* ---------- Header state + active section ---------- */
  const header = $('[data-header]');
  if (header) {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        header.classList.toggle('is-scrolled', scrollY > 8);
        ticking = false;
      });
    };
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  const navLinks = $$('[data-nav-link]');
  if (navLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map(navLinks.map((a) => [a.getAttribute('href').slice(1), a]));
    const visible = new Map();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => visible.set(en.target.id, en.isIntersecting ? en.intersectionRatio : 0));
      let best = null, bestRatio = 0;
      visible.forEach((ratio, id) => { if (ratio > bestRatio) { best = id; bestRatio = ratio; } });
      navLinks.forEach((a) => a.classList.remove('is-active'));
      if (best && byId.has(best)) byId.get(best).classList.add('is-active');
    }, { rootMargin: '-35% 0px -55% 0px', threshold: [0, 0.01, 0.25, 0.5, 0.75, 1] });
    byId.forEach((_, id) => { const s = d.getElementById(id); if (s) io.observe(s); });
  }

  /* ---------- Scroll reveals (only for elements below the fold at load) ---------- */
  if (!reduceMotion.matches && 'IntersectionObserver' in window) {
    const items = $$('[data-reveal]');
    const vh = innerHeight;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-in');
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach((el) => {
      // Tall blocks would sit invisible for a whole screen: never hide them.
      if (el.offsetHeight > vh * 0.9) return;
      if (el.getBoundingClientRect().top > vh * 0.92) {
        el.classList.add('will-reveal');
        io.observe(el);
      }
    });
    // Stagger siblings that reveal together.
    $$('.catalog, .principles, .certs').forEach((list) => {
      $$(':scope > [data-reveal]', list).forEach((el, i) => el.classList.add(`rv-${Math.min(i % 3, 2)}`));
    });
    // Jumping to a section (nav, CTA, #hash) shows its content at once instead of a blank screen.
    const revealSection = (id) => {
      let target = null;
      try { target = id ? d.getElementById(decodeURIComponent(id)) : null; } catch { /* malformed escape */ }
      if (!target) return;
      [target, ...$$('.will-reveal', target)].forEach((el) => {
        if (!el.classList.contains('will-reveal')) return;
        el.classList.add('is-in');
        io.unobserve(el);
      });
    };
    d.addEventListener('click', (e) => {
      const a = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null;
      if (a) revealSection(a.getAttribute('href').slice(1));
    });
    addEventListener('hashchange', () => revealSection(location.hash.slice(1)));
    revealSection(location.hash.slice(1));
  }
  root.classList.add('ready');

  /* ---------- Showcase pointer light ---------- */
  const glow = $('[data-glow]');
  if (glow && matchMedia('(hover: hover) and (pointer: fine)').matches && !reduceMotion.matches) {
    glow.addEventListener('pointermove', (e) => {
      const r = glow.getBoundingClientRect();
      glow.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
      glow.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
    });
  }

  /* ---------- Copy e-mail ---------- */
  const copyBtn = $('[data-copy]');
  const status = $('[data-copy-status]');
  if (copyBtn && navigator.clipboard && window.isSecureContext) {
    copyBtn.hidden = false;
    const label = $('.copy-text', copyBtn);
    const original = label ? label.textContent : '';
    let timer;
    copyBtn.addEventListener('click', async () => {
      let ok = true;
      try { await navigator.clipboard.writeText(copyBtn.dataset.copy); } catch { ok = false; }
      const msg = ok ? copyBtn.dataset.copied : copyBtn.dataset.failed;
      copyBtn.classList.toggle('is-done', ok);
      if (label) label.textContent = msg;
      if (status) status.textContent = msg;
      clearTimeout(timer);
      timer = setTimeout(() => {
        copyBtn.classList.remove('is-done');
        if (label) label.textContent = original;
        if (status) status.textContent = '';
      }, 2200);
    });
  }
})();
