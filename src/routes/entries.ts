import { Hono } from "hono";
import type { Env } from "../types";
import { authenticate, can } from "../lib/auth";
import { entriesCollection } from "../db";
import { collectionRoute } from "../lib/collection-route";

export const entriesRoute = new Hono<{ Bindings: Env }>();

// Static shortcut routes are registered ahead of the generic `/:id` route
// pulled in below (Hono's router prefers exact static segments over param
// segments regardless of registration order, but keeping them first here
// documents the precedence for humans too).
entriesRoute.get("/current", async (c) => {
  const auth = await authenticate(c);
  if (!can(auth, "api:entries:read")) return c.json({ status: 401, message: "Unauthorized" }, 401);
  const params = new URLSearchParams(new URL(c.req.url).search);
  params.set("count", "1");
  const docs = await entriesCollection(c.env.DB).list(params, { defaultLimit: 1 });
  return c.json(docs);
});

for (const type of ["sgv", "mbg", "cal"]) {
  entriesRoute.get(`/${type}`, async (c) => {
    const auth = await authenticate(c);
    if (!can(auth, "api:entries:read")) return c.json({ status: 401, message: "Unauthorized" }, 401);
    const params = new URLSearchParams(new URL(c.req.url).search);
    params.set("find[type]", type);
    const docs = await entriesCollection(c.env.DB).list(params, { defaultLimit: 10 });
    return c.json(docs);
  });
}

entriesRoute.route(
  "/",
  collectionRoute({ name: "entries", getCollection: entriesCollection, defaultLimit: 10, allowBulkInsert: true })
);
