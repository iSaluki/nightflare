import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { entriesRoute } from "./routes/entries";
import { treatmentsRoute } from "./routes/treatments";
import { devicestatusRoute } from "./routes/devicestatus";
import { profileRoute } from "./routes/profile";
import { foodRoute } from "./routes/food";
import { activityRoute } from "./routes/activity";
import { statusRoute, verifyAuthRoute } from "./routes/status";
import { adminRoute } from "./routes/admin";
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
app.route("/api/v1/admin", adminRoute);
app.route("/pebble", pebbleRoute);
app.route("/rt", realtimeRoute);

app.notFound((c) => c.json({ status: 404, message: "Not found" }, 404));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Nightscout clients commonly request e.g. /api/v1/entries.json; strip
    // the extension so both spellings hit the same routes.
    if (url.pathname.startsWith("/api/") && url.pathname.endsWith(".json")) {
      url.pathname = url.pathname.slice(0, -".json".length);
      request = new Request(url.toString(), request);
    }
    return app.fetch(request, env, ctx);
  },
};
