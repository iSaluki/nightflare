'use strict';
// Pre-renders Nightscout's EJS view shells to static HTML at build time.
// Our Worker has no per-request templating (it's not a long-lived Node
// process), so the small amount of server-side templating the real app
// does (a cachebuster-free bundle path + a couple of static partials) is
// baked in once here instead, then served as plain static files.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const viewsDir = path.join(__dirname, 'views');
const outDir = path.join(__dirname, '..', 'public');

// Flat .html filenames so Cloudflare's default asset html_handling
// ("auto-trailing-slash") serves them at clean extensionless URLs, e.g.
// GET /admin -> public/admin.html.
//
// The root dashboard is named `dashboard-classic.html`, NOT `index.html`:
// our Worker fetches it internally by exact path (src/index.ts's "/"
// handler, to pick between this and the new UI based on NEW_UI), and
// Cloudflare's asset binding unconditionally 307-redirects any request for
// a literal `index.html`/`*.html` filename to its canonical extensionless
// URL — including internal env.ASSETS.fetch() calls — so fetching
// "/index.html" from inside the Worker would just loop back to "/".
// Fetching the already-canonical "/dashboard-classic" avoids that.
const pages = [
  { file: 'index.html', out: 'dashboard-classic.html', type: 'index', title: '' },
  { file: 'adminindex.html', out: 'admin.html', type: 'admin', title: 'Admin Tools' },
  { file: 'foodindex.html', out: 'food.html', type: 'food', title: 'Food Editor' },
  { file: 'profileindex.html', out: 'profile.html', type: 'profile', title: 'Profile Editor' },
  { file: 'reportindex.html', out: 'report.html', type: 'report', title: 'Nightscout reporting' },
];

const locals = { bundle: '/bundle', cachebuster: 'nightflare' };

// Surfaces uncaught client-side errors directly on the loading screen.
// Without this, a JS exception during boot leaves the page stuck on
// "Loading the client" forever with no visible indication of what went
// wrong — the only trace is the browser console, which isn't reachable on
// e.g. mobile. Installed before any other script tag so it also catches
// errors thrown while bundle.app.js/client.js are first evaluated.
//
// Only fires up until the app's own successful boot hides the loading
// panel -- checked directly (not cached) each time, since that's the
// client's own signal that it made it past initialization. Afterwards,
// plenty of harmless runtime errors can happen (e.g. audio.play() being
// blocked by the browser's autoplay policy until the user interacts with
// the page, which the vendored alarm code doesn't catch) and none of
// those should hijack a working dashboard back into looking stuck/broken.
const errorOverlayScript = `
<script>
(function () {
  // Looked up fresh on every call, not cached at the top: this script runs
  // as the first thing in <body>, before #centerMessagePanel -- which comes
  // later in the HTML -- has been parsed into the DOM yet, so caching it
  // once here would permanently capture null.
  function show(text) {
    var panel = document.getElementById('centerMessagePanel');
    if (panel && panel.style.display === 'none') { return; }
    var el = document.getElementById('loadingMessageText');
    if (panel) { panel.style.display = ''; }
    if (el) { el.textContent = 'Error: ' + text; }
  }
  window.addEventListener('error', function (e) {
    show((e.error && (e.error.stack || e.error.message)) || e.message || 'unknown error');
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    show((r && (r.stack || r.message)) || String(r));
  });
})();
</script>
`;

for (const page of pages) {
  let html = ejs.render(fs.readFileSync(path.join(viewsDir, page.file), 'utf8'), {
    locals,
    title: page.title,
    type: page.type,
    settings: {},
  }, { views: [viewsDir, path.join(viewsDir, 'partials')] });

  html = html.replace('<body>', '<body>' + errorOverlayScript);

  // The vendored views never declare a document charset, and Cloudflare's
  // static-asset serving doesn't add `charset=utf-8` to the Content-Type
  // header the way Express's `express.static` (stock Nightscout's server)
  // always did. Without either signal, a browser's encoding guess is
  // locale-dependent — and since a same-origin <script src> with no
  // charset of its own inherits its containing document's encoding, a
  // non-UTF-8 guess corrupts the multi-byte characters embedded in
  // bundle.app.js (e.g. moment.js's non-English locale strings) into
  // invalid syntax, throwing a SyntaxError before `window.Nightscout` is
  // even defined — silently, since nothing ever updates the loading
  // screen after that. Must be the first thing in <head>, per the HTML
  // spec's requirement that the charset declaration appear within the
  // first 1024 bytes of the document.
  html = html.replace('<head>', '<head>\n  <meta charset="utf-8">');

  // Our RealtimeHub Durable Object speaks a small JSON-envelope protocol
  // instead of full socket.io/engine.io — swap in our shim, which exposes
  // the same `io.connect()` surface the bundle expects (see io-shim.js).
  html = html
    .split('<script src="/socket.io/socket.io.js"></script>')
    .join('<script src="/io-shim.js"></script>')
    .split('<script src="socket.io/socket.io.js"></script>')
    .join('<script src="/io-shim.js"></script>');
  // profileindex.html has a vestigial `<script src="/api/v1/status.js">`
  // tag — loading a JSON response as a <script> always throws a syntax
  // error in any Nightscout deployment; drop it rather than "fix" it into
  // a working-but-pointless script load.
  html = html.split('<script src="/api/v1/status.js"></script>\n').join('');

  if (page.type === 'admin') {
    // Nightflare-specific addition (not part of stock Nightscout): a link
    // to the "import from another Nightscout instance" page.
    html = html.replace(
      '<div id="admin_placeholder"></div>',
      '<div style="padding:10px 20px"><a href="/import" style="color:#8ab4f8">&#8594; Import from another Nightscout instance</a></div>\n    <div id="admin_placeholder"></div>'
    );
  }

  const outPath = path.join(outDir, page.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  console.log('wrote', path.relative(process.cwd(), outPath));
}

// The PWA offline-cache service worker index.html registers at /sw.js —
// also EJS-templated (just the cachebuster value).
const sw = ejs.render(fs.readFileSync(path.join(viewsDir, 'service-worker.js'), 'utf8'), { locals });
fs.writeFileSync(path.join(outDir, 'sw.js'), sw);
console.log('wrote', path.relative(process.cwd(), path.join(outDir, 'sw.js')));
