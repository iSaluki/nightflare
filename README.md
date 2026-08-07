# Nightflare

[Nightscout](https://nightscout.github.io/), running **entirely on Cloudflare's serverless
platform** — no VM, no MongoDB, no Node server to babysit — with the real, unmodified
Nightscout dashboard, careportal, profile/food editors, reports, and admin tools, all built
around a from-scratch backend on Workers, D1, KV, and Durable Objects.

## What this actually is

Nightscout's *server* (Node/Express + MongoDB, socket.io, cron jobs) can't run in Workers —
there's no long-lived process, no TCP server, no MongoDB driver. So Nightflare replaces the
server with a purpose-built one, but keeps the *client* — the actual dashboard code everyone
interacts with — genuinely unmodified, vendored straight from
[nightscout/cgm-remote-monitor](https://github.com/nightscout/cgm-remote-monitor). See
[`client/README.md`](client/README.md) for exactly what's vendored and how it's built.

| Nightscout (stock)         | Nightflare                                    |
|-----------------------------|------------------------------------------------|
| Node/Express server         | Cloudflare Worker (Hono)                       |
| MongoDB                     | D1 (SQLite)                                    |
| socket.io realtime push     | Durable Object + a small WebSocket JSON protocol, with a client-side shim standing in for the socket.io-client library |
| Cron / background jobs      | Durable Object alarms                          |
| Client dashboard/UI         | **The real Nightscout client bundle, vendored unmodified** |

## Feature coverage

Because the real client ships unmodified, all of its REST/WebSocket-driven features work as
long as the backend speaks the right protocol — which is most of what a single-user deployment
actually uses:

- **Live dashboard**: BG graph, IOB/COB/BWP/basal pills, alarms, careportal drawer — pushed
  live over WebSocket (`RealtimeHub` Durable Object), not polled.
- **Careportal**: logging treatments (meals, boluses, site changes, etc.) via the real drawer UI.
- **Profile editor** (`/profile`), **food editor** (`/food`), **reports** (`/report`, including
  day-to-day, distribution, percentile charts, and the loop analyzer) — all call the standard
  REST API and work unmodified.
- **Admin tools** (`/admin`): subject/role (API token) management and stale-data cleanup, via
  the real `admin_plugins` UI against a `/api/v2/authorization/*` implementation matching
  Nightscout's own contract.
- **REST API v1**: `entries`, `treatments`, `devicestatus`, `profile`, `food`, `activity`,
  `status`, `verifyauth`, the legacy `/pebble` watchface endpoint, and Mongo-style
  `find[field][$op]=value` queries (via SQLite's `json_extract`) — so xDrip+, Loop, AAPS, Spike,
  and any other Nightscout-speaking app work against a Nightflare deployment unmodified for both
  upload and download.
- **Auth**: `api-secret: sha1(API_SECRET)` header, exactly like stock Nightscout, plus scoped
  per-client tokens with role-based permissions (`admin`/`readable`/`careportal`/custom) —
  tokens are derived deterministically from a subject's id + `API_SECRET` (never stored raw),
  matching the "click the token to get a shareable link" UX of Nightscout's real admin UI.
- **Import from an existing Nightscout instance**: a Nightflare-specific addition (`/import`,
  linked from `/admin`) that pulls entries/treatments/devicestatus/profile/food/activity from
  another Nightscout site's REST API, given its URL and `API_SECRET`. Runs as a Durable Object
  alarm loop in paginated batches, so it comfortably handles years of history well outside any
  single request's time budget.

### What's genuinely out of scope

A few Nightscout features need infrastructure that doesn't make sense — or doesn't exist — in a
serverless, single-tenant Workers deployment, so they're left out rather than half-implemented:

- **Pushover / Apple Push (APN) notifications** and the **Alexa / Google Home** skills need
  persistent third-party OAuth credentials and, in APN's case, a long-lived certificate-based
  connection — infrastructure a personal Workers deployment has no good place to hold.
- **Server-computed OpenAPS/Loop plugin calculations** beyond storing/serving `devicestatus` as
  uploaded: real Nightscout mostly treats these as pass-through anyway (the looping app computes
  IOB/COB and uploads the result), which Nightflare already does.
- Real-time **alarm-acknowledgement sync across multiple simultaneous viewers** (the `/alarm`
  socket.io namespace) is acked but not implemented — each browser tab manages its own alarm
  state, same as if two people had two different stock Nightscout tabs open with no shared
  alarm-silence state.

## Architecture

```
                       ┌──────────────────────────────┐
 xDrip+ / Loop / AAPS  │                               │
 follower apps  ──────►│   Cloudflare Worker (Hono)    │◄──── real Nightscout
 real Nightscout UI    │   /api/v1/*  /api/v2/*  /rt   │      client bundle
 (vendored, unmodified)│   /pebble                     │      (public/, built
                       └───────┬────────────┬──────────┘       from client/)
                               │            │
                    ┌──────────▼───┐   ┌────▼─────────────────┐
                    │  D1 (SQLite) │   │  Durable Objects       │
                    │  entries     │   │  RealtimeHub — speaks  │
                    │  treatments  │   │  a small WS protocol   │
                    │  devicestatus│   │  the vendored client's │
                    │  profiles    │   │  io-shim.js talks to   │
                    │  food        │   │                        │
                    │  activity    │   │  ImportJob — alarm-    │
                    │  auth_*      │   │  driven background     │
                    │  import_jobs │   │  pull from another     │
                    └──────────────┘   │  Nightscout site       │
                                       └─────────────────────────┘
```

Each D1 table keeps a few indexed columns (`date`, `type`/`eventType`, `device`) for fast
range/sort queries, plus a `data` JSON column holding the document exactly as received — so
uploader-specific fields are never dropped, and `find[field][$op]=value` queries work against
arbitrary fields via `json_extract`.

## Deploying

### 1. Prerequisites

```bash
npm install
npm run build:client   # builds the vendored client bundle into public/ (already committed,
                        # only needed again if you change client/)
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

## Importing from an existing Nightscout instance

Visit `/admin` → **Import from another Nightscout instance**, or call the API directly:

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

Poll progress with `GET /api/v1/admin/import/<jobId>` (the POST above returns the `jobId`).

## Project layout

```
src/
  index.ts                  Worker entry point, routing, .json/trailing-slash normalization
  types.ts                  Env bindings (D1/KV/DO/Assets)
  lib/
    auth.ts                 api-secret + subject-token + JWT authentication, permission checks
    jwt.ts                  minimal HS256 JWT (Web Crypto), for the token → session exchange
    collection-route.ts     generic CRUD route factory shared by all collections
    mongo-query.ts          find[field][$op]=value  ->  SQL WHERE
    crypto.ts, id.ts, realtime.ts
  db/                       D1 access layer (one Collection per Nightscout collection)
  durable-objects/
    realtime-hub.ts         WebSocket protocol: authorize/dataUpdate/loadRetro/dbAdd/dbUpdate
    import-job.ts           alarm-driven background import from another Nightscout site
  routes/                   one file per API resource (entries, treatments, status, admin, ...)
migrations/                 D1 schema
client/                     vendored Nightscout client source + build tooling — see client/README.md
public/                     built static assets served by the Worker (the vendored UI + our own
                             io-shim.js and import.html)
```
