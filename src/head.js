/* Inlined in <head>, runs before first paint: theme (no flash) + remembered language.
 * Language: a first visit always gets the Spanish default at "/" (nothing is stored yet, and
 * crawlers have no storage). Only after a visitor explicitly picks English or Chinese in the
 * switcher does a later plain visit to "/" open that language. It is skipped for same-site
 * navigation (so the switcher's "Español" link always works), for URLs with a query string or
 * #fragment (deep links stay as shared), and it uses location.replace, so Back never loops. */
(function (d) {
  var r = d.documentElement, c = __CONFIG__;
  r.classList.add('js');
  try {
    var t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') r.setAttribute('data-theme', t);
    var l = localStorage.getItem('lang');
    var p = location.pathname;
    if (r.getAttribute('data-lang') === c.d && l && l !== c.d && c.p[l] && (p === '/' || p === '/index.html') && !location.search && !location.hash) {
      var ref = d.referrer, same = false;
      try { same = !!ref && new URL(ref).origin === location.origin; } catch (e) {}
      if (!same) location.replace(c.p[l]);
    }
  } catch (e) {}
})(document);
