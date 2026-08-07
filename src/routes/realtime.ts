import { Hono } from "hono";
import type { Env } from "../types";
import { realtimeStub } from "../lib/realtime";

// Browser dashboards connect here for live updates instead of Nightscout's
// socket.io stream. The Worker just forwards the upgrade to the singleton
// RealtimeHub Durable Object, which holds the hibernating connections.
export const realtimeRoute = new Hono<{ Bindings: Env }>();

realtimeRoute.get("/", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ status: 426, message: "expected a websocket upgrade" }, 426);
  }
  return realtimeStub(c.env).fetch(c.req.raw);
});
