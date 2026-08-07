import { Hono } from "hono";
import type { Env } from "../types";
import { authenticate, can } from "../lib/auth";
import { foodCollection } from "../db";
import { collectionRoute } from "../lib/collection-route";

export const foodRoute = new Hono<{ Bindings: Env }>();

// Shortcuts the food editor UI calls on load — filters by the food
// document's `type` field ("quickpick" vs "food"), not `category`.
foodRoute.get("/quickpicks", async (c) => {
  const auth = await authenticate(c);
  if (!can(auth, "api:food:read")) return c.json({ status: 401, message: "Unauthorized" }, 401);
  const params = new URLSearchParams(new URL(c.req.url).search);
  params.set("find[type]", "quickpick");
  const docs = await foodCollection(c.env.DB).list(params, { defaultLimit: 100 });
  return c.json(docs);
});

foodRoute.get("/regular", async (c) => {
  const auth = await authenticate(c);
  if (!can(auth, "api:food:read")) return c.json({ status: 401, message: "Unauthorized" }, 401);
  const params = new URLSearchParams(new URL(c.req.url).search);
  params.set("find[type]", "food");
  const docs = await foodCollection(c.env.DB).list(params, { defaultLimit: 100 });
  return c.json(docs);
});

foodRoute.route("/", collectionRoute({ name: "food", getCollection: foodCollection, defaultLimit: 100 }));
