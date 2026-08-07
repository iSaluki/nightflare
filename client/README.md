# Vendored Nightscout client

This directory is the client-side source from
[nightscout/cgm-remote-monitor](https://github.com/nightscout/cgm-remote-monitor)
(AGPL-3.0), copied in **unmodified** and used only to build the browser
bundle Nightflare serves — the dashboard, careportal drawer, profile/food
editors, reports, and admin tools. It's what makes Nightflare's web UI
genuinely feature-complete rather than a reimplementation: Nightflare's own
code never re-implements any of this UI, it just serves the real thing and
implements a REST + WebSocket API compatible enough for it to run unmodified
against D1 instead of MongoDB.

**Only `lib/client`, `lib/plugins`, `lib/report_plugins`, `lib/admin_plugins`,
`lib/profile`, `lib/food`, `lib/data`, `static/`, `views/`, and
`translations/` are actually reachable from the webpack entry
(`bundle/bundle.source.js`) and get bundled.** The rest of `lib/` (`server/`,
`api/`, `api2/`, `storage/`, `authorization/`) is upstream's original
Node/Express/MongoDB server — dead weight here, kept only because pruning it
risked breaking a transitive `require()` somewhere in the bundled graph.
Nightflare's actual server is `../src/`, running as a Cloudflare Worker
against D1/KV/Durable Objects; nothing under `client/lib/server` or
`client/lib/api*` ever executes.

## Rebuilding

```
npm run build:client   # from the repo root
```

This installs `client/`'s own dependencies (the same ones upstream
Nightscout uses — jQuery, D3, moment, flot, etc. — pulled via its original
`package.json`/`package-lock.json`), pre-renders the EJS view shells
(`prerender.js`) into `../public/*.html`, and runs webpack to produce
`../public/bundle/js/bundle.app.js`. The built output is committed to the
repo under `public/`, so this only needs to be re-run if you change
something under `client/`.

## The realtime shim

Every page loads `<script src="/socket.io/socket.io.js">` upstream; our
pre-render step (`prerender.js`) rewrites that to `/io-shim.js` instead.
`lib/client/index.js`'s `io.connect(...)` calls are otherwise untouched —
`io-shim.js` implements just enough of the socket.io client surface
(`.on`/`.emit` with ack callbacks) over a plain WebSocket to Nightflare's
`RealtimeHub` Durable Object. See `../src/durable-objects/realtime-hub.ts`
for the server side of that protocol.
