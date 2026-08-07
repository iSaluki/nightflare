import { Hono } from "hono";
import type { Env } from "../types";
import { authenticate, can } from "./auth";
import { Collection, type DocBase } from "../db/collection";
import { notifyChange } from "./realtime";

interface Options {
  name: string; // e.g. "entries" -> permission namespace "api:entries:*"
  getCollection: (db: D1Database) => Collection;
  defaultLimit?: number;
  /** entries/treatments accept array bodies on POST for bulk uploads. */
  allowBulkInsert?: boolean;
}

function stripInternal(doc: DocBase): DocBase {
  return doc;
}

export function collectionRoute(opts: Options): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const perm = (action: string) => `api:${opts.name}:${action}`;

  app.get("/", async (c) => {
    const auth = await authenticate(c);
    if (!can(auth, perm("read"))) return c.json({ status: 401, message: "Unauthorized" }, 401);
    const col = opts.getCollection(c.env.DB);
    const docs = await col.list(new URL(c.req.url).searchParams, { defaultLimit: opts.defaultLimit ?? 10 });
    return c.json(docs.map(stripInternal));
  });

  app.get("/:id", async (c) => {
    const auth = await authenticate(c);
    if (!can(auth, perm("read"))) return c.json({ status: 401, message: "Unauthorized" }, 401);
    const col = opts.getCollection(c.env.DB);
    const doc = await col.getById(c.req.param("id"));
    if (!doc) return c.json({ status: 404, message: "Not found" }, 404);
    return c.json(doc);
  });

  app.post("/", async (c) => {
    const auth = await authenticate(c);
    if (!can(auth, perm("create"))) return c.json({ status: 401, message: "Unauthorized" }, 401);
    const col = opts.getCollection(c.env.DB);
    const body = await c.req.json<DocBase | DocBase[]>();
    let result: DocBase | DocBase[];
    if (Array.isArray(body)) {
      if (!opts.allowBulkInsert) return c.json({ status: 400, message: "Bulk insert not supported" }, 400);
      result = await col.insertMany(body);
    } else {
      result = await col.insert(body);
    }
    await notifyChange(c.env, opts.name, "create");
    return c.json(result, 201);
  });

  app.put("/", async (c) => {
    const auth = await authenticate(c);
    if (!can(auth, perm("update"))) return c.json({ status: 401, message: "Unauthorized" }, 401);
    const col = opts.getCollection(c.env.DB);
    const body = await c.req.json<DocBase>();
    if (!body._id) return c.json({ status: 400, message: "_id is required for update" }, 400);
    const result = await col.update(body._id, body);
    await notifyChange(c.env, opts.name, "update");
    return c.json(result);
  });

  app.put("/:id", async (c) => {
    const auth = await authenticate(c);
    if (!can(auth, perm("update"))) return c.json({ status: 401, message: "Unauthorized" }, 401);
    const col = opts.getCollection(c.env.DB);
    const body = await c.req.json<DocBase>();
    const result = await col.update(c.req.param("id"), body);
    await notifyChange(c.env, opts.name, "update");
    return c.json(result);
  });

  app.delete("/:id", async (c) => {
    const auth = await authenticate(c);
    if (!can(auth, perm("delete"))) return c.json({ status: 401, message: "Unauthorized" }, 401);
    const col = opts.getCollection(c.env.DB);
    await col.deleteById(c.req.param("id"));
    await notifyChange(c.env, opts.name, "delete");
    return c.body(null, 204);
  });

  app.delete("/", async (c) => {
    const auth = await authenticate(c);
    if (!can(auth, perm("delete"))) return c.json({ status: 401, message: "Unauthorized" }, 401);
    const col = opts.getCollection(c.env.DB);
    const deleted = await col.deleteWhere(new URL(c.req.url).searchParams);
    await notifyChange(c.env, opts.name, "delete");
    return c.json({ deleted });
  });

  return app;
}
