# Nightflare

[Nightscout](https://nightscout.github.io/), running **entirely on Cloudflare's serverless
platform** — no VM, no MongoDB, no Node server to babysit — with the real, unmodified
Nightscout dashboard, careportal, profile/food editors, reports, and admin tools, all built
around a from-scratch backend on Workers, D1, KV, and Durable Objects.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iSaluki/nightflare)

Deploying this way forks the repo into your own GitHub account, provisions the D1 database, KV
namespace, and Durable Objects declared in `wrangler.toml` on your Cloudflare account, applies
the D1 migrations (via the `predeploy` script, so the `deploy` step below always runs against an
up-to-date schema), and deploys. You'll still need to set `API_SECRET` yourself afterwards — see
[Set your API secret](#4-set-your-api-secret) below — the button can't safely generate and hand
you back a real secret.

## Preamble

I decided to create this project as I wanted to be able to deploy Nightscout onto the Cloudflare Serverless platform. It is designed to be usable within free tier limits, but I cannot guarantee that you won't hit any limits at all.

Nightflare uses code from Nightscout but works rather differently under the hood, meaning this isn't a straight fork of Nightscout. There isn't perfect feature parity, although I have done my best to include the main functionality. 

In addition to the Nightscout feature set, this project also implements:

- Deployment to Cloudflare target, and a button to quickly create your own deployment
- A Nightscout importer, capable of importing data from an existing Nightscout instance (there is a link in the admin panel)
- A `NEW_UI` environment variable that defaults to `false` but can be toggled to `true` to enable a WIP new interface for Nightflare.

Before deploying this, you should understand:

- This project was largely architected and written by Claude, so mileage may vary and, as standard, **I cannot provide any warranty for the functionality or integrity of your data if you deploy this**.
- This was designed for my own use case and may not work perfectly with yours.
- You are free to open issues or pull requests if you would like any changes. I will review these on a best effort basis. Forks of this repository are welcome and encouraged if you think you can make something even better.
- The backend code has been changed drastically. Whilst it looks a lot like Nightscout and does contain a lot of Nightscout code, we are using a different type of database engine and are avoiding any persistent processes in the background. This massive set of changes combined with so far limited real world testing means that there may be some unintended issues still - although I do hope to even them out over time. 

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
  matching the "click the token to get a shareable link" UX of Nightscout's real admin UI. By
  default, a request presenting no credential at all gets **no access** to anything, glucose data
  included — see [`AUTH_DEFAULT_ROLES`](#access-control-auth_default_roles) below if you actually
  want stock Nightscout's traditional anyone-with-the-url-can-read behavior back.
- **Import from an existing Nightscout instance**: a Nightflare-specific addition (`/import`,
  linked from `/admin`) that pulls entries/treatments/devicestatus/profile/food/activity from
  another Nightscout site's REST API, given its URL and `API_SECRET`. Runs as a Durable Object
  alarm loop in paginated batches, so it comfortably handles years of history well outside any
  single request's time budget.

## Access control (`AUTH_DEFAULT_ROLES`)

A request presenting no `api-secret`/`token` at all gets whatever role(s) `AUTH_DEFAULT_ROLES`
names — space- or comma-separated, matching a role's `name` (`admin`, `readable`, `careportal`,
`denied`, or any custom role you've created). **This defaults to `"denied"` when unset: no
glucose data, treatments, or anything else is served to an unauthenticated request.** Every route
checks this *before* touching the database, and the same check gates the WebSocket realtime feed
(both the initial push and the retro-history load), so an unauthenticated client can't get data
through either path.

This is a deliberate departure from stock Nightscout, whose historical `AUTH_DEFAULT_ROLES`
default is `"readable"` — meaning glucose data is visible to anyone who has the URL, no token
required, which many real deployments rely on for quick access from any device without a login
step. If you want that behavior here, set it explicitly:

```toml
# wrangler.toml
[vars]
AUTH_DEFAULT_ROLES = "readable"
```

## Optional: a modern dashboard (`NEW_UI`)

Set the `NEW_UI` variable in `wrangler.toml` (or `wrangler deploy --var NEW_UI:true`) to `"true"`
to replace the dashboard at `/` with Nightflare's own UI — a from-scratch design (see
`public/new-ui/`) rather than the vendored Nightscout client. It talks to the same REST API and
the same `RealtimeHub` WebSocket protocol directly (no socket.io shim involved), so live updates,
authentication, and logging a treatment all work the same way, just with a different look:

- A calmer, instrument-panel visual language (a cool graphite base, a single muted accent per
  glucose zone, a smoothed waveform graph) instead of the classic dark/neon CGM-dashboard look.
- A vertical timeline for treatments, since the data is inherently a timeline.
- Honest, simply-computed stats (carbs/insulin logged in the last 24h, time since last entry) —
  it does **not** attempt to reproduce IOB/COB decay curves; showing an incorrectly-modeled
  insulin-on-board number would be actively misleading, so that's left to the vendored UI/looping
  apps that actually compute it correctly.

**This only replaces the dashboard.** `/admin`, `/food`, `/profile`, and `/report` always stay on
the vendored Nightscout UI regardless of `NEW_UI` — profile editing, reports, and admin tools
aren't reimplemented here. `NEW_UI` is a deployment-wide setting, not a per-visitor toggle; both
UIs are always deployed side by side (the vendored one stays reachable, unlisted, at
`/dashboard-classic` and the new one at `/new-ui/dashboard`, whichever `NEW_UI` doesn't pick for
`/`).

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

(`npm run deploy` in step 5 also runs this automatically via its `predeploy` hook, so this step
is mostly useful if you want the schema in place before setting the API secret below.)

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

### 6. (Optional) Use your own domain instead of *.workers.dev

Whether you deployed via the button or the CLI, your site is reachable at
`<name>.<your-subdomain>.workers.dev` by default. To use your own domain
instead: add the domain to this Cloudflare account as a zone if it isn't
already there (dashboard -> Websites -> Add a domain), then either

- uncomment and fill in the `[[routes]]` block in `wrangler.toml`, then
  redeploy (`npm run deploy`, or push to your fork if you're relying on the
  button's auto-deploy-on-push), or
- skip `wrangler.toml` entirely and add it via the dashboard instead: your
  Worker's page -> Settings -> Domains & Routes -> Add -> Custom Domain.

The Deploy to Cloudflare button itself can't prompt for a domain inline — it
only provisions whatever `wrangler.toml` already declares — so this is
always a short follow-up step rather than something the button does for you.

### Local development

```bash
cp .dev.vars.example .dev.vars   # then edit in a real secret
npm run db:migrate:local
npm run dev
```

To try the new dashboard locally without editing `wrangler.toml`:
`npx wrangler dev --var NEW_UI:true`.

## Updating a button-deployed repo

Clicking **Deploy to Cloudflare** copies this repo's contents into a **brand-new, independent
repository** in your GitHub account — it is *not* a GitHub fork. GitHub only records the
fork/parent relationship when a repo is created via its own Fork feature (the "Fork" button, or
`gh repo fork`); a repo created by pushing a copy of files into a freshly-created empty repo,
which is what the button does, has no such relationship, and **there is no API or UI action that
can retroactively attach one after the fact.** That's a GitHub platform limitation, not something
this project (or git) can work around — so if you want the "Sync fork" button and the "forked
from iSaluki/nightflare" badge specifically, the only way to get them is to delete your
button-deployed repo and create a real fork instead (see below), reapplying any local changes
you'd made on top of it.

For the actual goal most people have — *pulling in updates from this repo* — you don't need any
of that. Git doesn't care about GitHub's fork bookkeeping; add this repo as a second remote and
merge from it like any other upstream:

```bash
git remote add upstream https://github.com/iSaluki/nightflare.git
git fetch upstream
git merge upstream/main        # or: git rebase upstream/main
git push origin main
```

If you deployed via the button, pushing to `main` on your repo triggers Cloudflare's
auto-deploy-on-push, so the merge above is also how you roll an update out — no need to click
"Deploy to Cloudflare" again. Migrations run automatically on deploy (see `predeploy` in
`package.json`), so any new ones land the same way.

### If you specifically want a real GitHub fork instead

1. Note anything you've customized in your existing repo (env vars in `wrangler.toml`, any code
   changes) — you'll be re-applying those.
2. Fork `iSaluki/nightflare` for real, via GitHub's "Fork" button on
   [the repo page](https://github.com/iSaluki/nightflare) (or `gh repo fork iSaluki/nightflare`).
3. Re-apply your customizations to the new fork (cherry-pick commits from your old repo, or just
   redo the edits — usually just a few `wrangler.toml` var changes).
4. Point Cloudflare at the new fork: your Worker's page in the dashboard -> Settings -> Build ->
   disconnect the old repo, connect the new fork. Existing D1/KV/deployed data is untouched by
   this — only which repo triggers future deploys changes.
5. Delete the old button-created repo once you've confirmed the new fork deploys correctly (or
   keep it around; it's harmless either way, just no longer connected to anything).

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
public/                     static assets served by the Worker
  dashboard-classic.html      the vendored Nightscout dashboard (built from client/)
  new-ui/                     Nightflare's own dashboard (see "Optional: a modern dashboard" above)
  io-shim.js, import.html     Nightflare-specific additions
```
