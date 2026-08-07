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
const pages = [
  { file: 'index.html', out: 'index.html', type: 'index', title: '' },
  { file: 'adminindex.html', out: 'admin.html', type: 'admin', title: 'Admin Tools' },
  { file: 'foodindex.html', out: 'food.html', type: 'food', title: 'Food Editor' },
  { file: 'profileindex.html', out: 'profile.html', type: 'profile', title: 'Profile Editor' },
  { file: 'reportindex.html', out: 'report.html', type: 'report', title: 'Nightscout reporting' },
];

const locals = { bundle: '/bundle', cachebuster: 'nightflare' };

for (const page of pages) {
  let html = ejs.render(fs.readFileSync(path.join(viewsDir, page.file), 'utf8'), {
    locals,
    title: page.title,
    type: page.type,
    settings: {},
  }, { views: [viewsDir, path.join(viewsDir, 'partials')] });

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
