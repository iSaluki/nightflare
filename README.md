# Nightflare

A [Nightscout](https://nightscout.github.io/)-compatible CGM data platform that runs **entirely
on Cloudflare's serverless platform** — no VM, no MongoDB, no Node server to babysit.

| Nightscout (stock)        | Nightflare                          |
|----------------------------|--------------------------------------|
| Node/Express server        | Cloudflare Worker (Hono)             |
| MongoDB                    | D1 (SQLite)                          |
| In-memory settings cache   | Workers KV                           |
| socket.io realtime push    | Durable Object + WebSocket Hibernation |
| Background/cron jobs       | Durable Object alarms                |
| Static frontend bundle     | Workers Static Assets                |

## Why this exists

Nightscout is normally deployed on a VM, Heroku dyno, or Docker host talking to a MongoDB
instance. Nightflare reimplements the same **client-facing REST API** (the part every uploader —
xDrip+, Loop, AAPS, Spike — and every follower app actually depends on) on top of Cloudflare's
managed primitives, so the whole thing scales to zero and costs nothing to run for a single user.

## Architecture

```
                       ┌─────────────────────────────┐
 xDrip+ / Loop / AAPS  │                              │
 follower apps  ──────►│   Cloudflare Worker (Hono)   │
 web dashboard         │   /api/v1/*  /pebble  /rt    │
                       └───────┬───────────┬──────────┘
                               │           │
                    ┌──────────▼───┐   ┌───▼────────────────┐
                    │  D1 (SQLite) │   │  Durable Objects    │
                    │  entries     │   │  RealtimeHub (WS)   │
                    │  treatments  │   │  ImportJob (alarm-  │
                    │  devicestatus│   │  driven background  │
                    │  profiles    │   │  pull from another  │
                    │  food        │   │  Nightscout site)   │
                    │  activity    │   └─────────────────────┘
                    │  auth_*      │
                    │  import_jobs │
                    └──────────────┘
```

Each D1 table keeps a few indexed columns (`date`, `type`/`eventType`, `device`) for fast
range/sort queries, plus a `data` JSON column holding the document exactly as received — so
uploader-specific fields are never dropped, and `find[field][$op]=value` queries (the Mongo-style
syntax every Nightscout client already speaks) work against arbitrary fields via SQLite's `json_extract`.

## API compatibility

Implements the Nightscout API v1 surface that the client ecosystem actually relies on:

- `GET/POST/PUT/DELETE /api/v1/entries[.json]`, plus `/entries/current`, `/entries/sgv`, `/entries/mbg`, `/entries/cal`
- `GET/POST/PUT/DELETE /api/v1/treatments[.json]` (bulk-array POST supported, for uploader batching)
- `GET/POST/PUT/DELETE /api/v1/devicestatus[.json]`
- `GET/POST/PUT/DELETE /api/v1/profile[.json]`, plus `/profile/current`
- `GET/POST/PUT/DELETE /api/v1/food[.json]`, `/api/v1/activity[.json]`
- `GET /api/v1/status.json`, `GET /api/v1/verifyauth`
- `GET /pebble` (legacy watchface endpoint)
- Mongo-style querying: `find[date][$gte]=...`, `find[type]=sgv`, `count=N`, etc.
- Auth: `api-secret: sha1(API_SECRET)` header (byte-for-byte the same scheme Nightscout uses), plus
  scoped per-client tokens with role-based permissions (`admin`, `readable`, `careportal`, or custom
  roles) — see the **Admin** tab in the web UI.
- Realtime: dashboards get push updates over a `/rt` WebSocket instead of socket.io.

### Known gaps vs. stock Nightscout

This is a from-scratch reimplementation, not a port of the original codebase, so it does **not**
include: the original AngularJS admin/report plugins (day-to-day, week-to-week, distribution
reports), Care Portal's full form catalog, or the OpenAPS/Loop-specific plugin computations
(IOB/COB curves) — those are computed client-side by the uploader/looping apps themselves and
just stored/served as-is here, which is how most of the ecosystem actually consumes Nightscout.
The web UI here is a clean custom dashboard (BG graph, treatments log, profile editor, admin) built
for this project rather than a vendored copy of Nightscout's legacy frontend bundle.

## Importing from an existing Nightscout instance

Admin tab → **Import from another Nightscout instance** → enter the source site's URL and its
`API_SECRET` (used only to authenticate the pull; it's hashed before being sent and never stored).
Or call the API directly:

```bash
curl -X POST https://your-site.workers.dev/api/v1/admin/import \
  -H "api-secret: $(printf '%s' "$API_SECRET" | sha1sum | cut -d' ' -f1)" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceUrl": "https://my-old-nightscout.herokuapp.com",
    "apiSecret": "the-old-sites-api-secret",
    "collections": ["entries", "treatments", "devicestatus", "profile", "food", "activity"]
  }'
```

This returns a `jobId` immediately; the import itself runs in the background as a Durable Object
(`ImportJob`) driven by alarms, paging through the source's REST API 500 records at a time — so it
comfortably handles years of CGM history without hitting any single-request time limit. Poll
progress with:

```bash
curl https://your-site.workers.dev/api/v1/admin/import/<jobId> -H "api-secret: ..."
```

## Deploying

### 1. Prerequisites

```bash
npm install
```

### 2. Create the D1 database and KV namespace

```bash
npx wrangler d1 create nightflare-db
npx wrangler kv namespace create SETTINGS_KV
```

Copy the `database_id` and KV `id` from the output into `wrangler.toml` (replacing
`REPLACE_WITH_D1_DATABASE_ID` and `REPLACE_WITH_KV_NAMESPACE_ID`).

### 3. Apply migrations

```bash
npm run db:migrate:remote
```

### 4. Set your API secret

```bash
npx wrangler secret put API_SECRET
```

Use a long random string — the same value you'd put in Nightscout's `API_SECRET` env var. Every
uploader/follower app sends `sha1(API_SECRET)` as the `api-secret` header, exactly as with stock
Nightscout, so existing app configs work unmodified once pointed at your new URL.

### 5. Deploy

```bash
npm run deploy
```

### Local development

```bash
echo 'API_SECRET="something-long-and-random"' > .dev.vars
npm run db:migrate:local
npm run dev
```

## Project layout

```
src/
  index.ts                  Worker entry point, routing, .json suffix handling
  types.ts                  Env bindings (D1/KV/DO/Assets)
  lib/
    auth.ts                 api-secret + subject-token authentication, permission checks
    collection-route.ts     generic CRUD route factory shared by all collections
    mongo-query.ts          find[field][$op]=value  ->  SQL WHERE
    crypto.ts, id.ts, realtime.ts
  db/                       D1 access layer (one Collection per Nightscout collection)
  durable-objects/
    realtime-hub.ts         WebSocket fan-out for live dashboard updates
    import-job.ts           alarm-driven background import from another Nightscout site
  routes/                   one file per API resource
migrations/                 D1 schema
public/                     static web UI (dashboard, treatments, profile, admin) — no build step
```
