import { Hono } from "hono";
import type { Env } from "../types";
import { authenticate, can } from "../lib/auth";
import { profilesCollection } from "../db";
import { collectionRoute } from "../lib/collection-route";

export const profileRoute = new Hono<{ Bindings: Env }>();

profileRoute.get("/current", async (c) => {
  const auth = await authenticate(c);
  if (!can(auth, "api:profile:read")) return c.json({ status: 401, message: "Unauthorized" }, 401);
  const params = new URLSearchParams(new URL(c.req.url).search);
  params.set("count", "1");
  const [latest] = await profilesCollection(c.env.DB).list(params, { defaultLimit: 1 });
  if (!latest) return c.json({ status: 404, message: "No profile set" }, 404);
  return c.json(latest);
});

profileRoute.route(
  "/",
  collectionRoute({ name: "profile", getCollection: profilesCollection, defaultLimit: 20, allowBulkInsert: true })
);
