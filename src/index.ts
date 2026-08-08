import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { entriesRoute } from "./routes/entries";
import { treatmentsRoute } from "./routes/treatments";
import { devicestatusRoute } from "./routes/devicestatus";
import { profileRoute } from "./routes/profile";
import { foodRoute } from "./routes/food";
import { activityRoute } from "./routes/activity";
import { statusRoute, verifyAuthRoute, adminNotifiesRoute } from "./routes/status";
import { adminRoute } from "./routes/admin";
import { authorization2Route } from "./routes/authorization2";
import { pebbleRoute } from "./routes/pebble";
import { realtimeRoute } from "./routes/realtime";

export { RealtimeHub } from "./durable-objects/realtime-hub";
export { ImportJob } from "./durable-objects/import-job";

const app = new Hono<{ Bindings: Env }>();

// Nightscout's API has always been wide open to CORS so mobile/watch apps
// and third-party dashboards can call it directly from the browser.
app.use("/api/*", cors());

app.route("/api/v1/entries", entriesRoute);
app.route("/api/v1/treatments", treatmentsRoute);
app.route("/api/v1/devicestatus", devicestatusRoute);
app.route("/api/v1/profile", profileRoute);
app.route("/api/v1/food", foodRoute);
app.route("/api/v1/activity", activityRoute);
app.route("/api/v1/status", statusRoute);
app.route("/api/v1/verifyauth", verifyAuthRoute);
app.route("/api/v1/adminnotifies", adminNotifiesRoute);
app.route("/api/v1/admin", adminRoute);
app.route("/api/v2/authorization", authorization2Route);
app.route("/pebble", pebbleRoute);
app.route("/rt", realtimeRoute);

// NEW_UI swaps the dashboard, admin, food, profile, and report pages for
// their modern (public/new-ui/*) equivalents; each still falls back to the
// vendored Nightscout client page of the same name when NEW_UI is "false".
// Fetched by their already-canonical (extensionless) path: Cloudflare's
// asset binding 307-redirects any literal "*.html" filename — including
// index.html — to its canonical URL even for internal ASSETS.fetch() calls,
// so fetching the canonical path directly is what actually returns content.
function serveUiPage(newUiName: string, vendoredName: string) {
  return async (c: Context<{ Bindings: Env }>) => {
    const url = new URL(c.req.url);
    url.pathname = c.env.NEW_UI === "true" ? `/new-ui/${newUiName}` : `/${vendoredName}`;
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  };
}

app.get("/", serveUiPage("dashboard", "dashboard-classic"));
app.get("/admin", serveUiPage("admin", "admin"));
app.get("/food", serveUiPage("food", "food"));
app.get("/profile", serveUiPage("profile", "profile"));
app.get("/report", serveUiPage("report", "report"));

app.notFound((c) => c.json({ status: 404, message: "Not found" }, 404));

// Without this, an uncaught exception anywhere in a route handler (e.g. a
// D1 error) falls through to the Workers runtime's default plain-text
// "Internal Server Error" response. Every client here — including the
// vendored Nightscout UI and import.html — assumes JSON and calls
// res.json() unconditionally, so that plain-text body surfaces as a
// confusing "Unexpected token 'I' ... is not valid JSON" instead of the
// real error.
app.onError((err, c) => {
  console.error(err);
  return c.json({ status: 500, message: err instanceof Error ? err.message : "Internal server error" }, 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let rewritten = false;

    // Nightscout clients commonly request e.g. /api/v1/entries.json; strip
    // the extension so both spellings hit the same routes.
    if (url.pathname.startsWith("/api/") && url.pathname.endsWith(".json")) {
      url.pathname = url.pathname.slice(0, -".json".length);
      rewritten = true;
    }
    // The vendored client itself posts to e.g. /api/v1/treatments/ and
    // /api/v2/authorization/subjects/ with a trailing slash; our routes are
    // mounted without one.
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
      rewritten = true;
    }

    if (rewritten) request = new Request(url.toString(), request);
    return app.fetch(request, env, ctx);
  },
};
