import { Hono } from "hono";
import type { Env } from "../types";
import { authenticate, deriveAccessToken, issueAuthorization } from "../lib/auth";
import { generateId } from "../lib/id";

// Matches Nightscout's /api/v2/authorization/* contract exactly (see
// lib/authorization/endpoints.js and admin_plugins/subjects.js, roles.js in
// the vendored client) so the real, unmodified admin UI works against our
// D1-backed auth tables.
export const authorization2Route = new Hono<{ Bindings: Env }>();

function normalizeArrayField(body: Record<string, unknown>, key: string): string[] {
  const raw = body[`${key}[]`] ?? body[key];
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

authorization2Route.get("/request/:accessToken", async (c) => {
  const authorized = await issueAuthorization(c.env, c.req.param("accessToken"));
  if (!authorized) return c.json({ status: 401, message: "Unauthorized", description: "Invalid/Missing" }, 401);
  return c.json(authorized);
});

authorization2Route.use("/subjects/*", async (c, next) => {
  const auth = await authenticate(c);
  if (!auth.isAdmin) return c.json({ status: 401, message: "Unauthorized" }, 401);
  await next();
});
authorization2Route.use("/subjects", async (c, next) => {
  const auth = await authenticate(c);
  if (!auth.isAdmin) return c.json({ status: 401, message: "Unauthorized" }, 401);
  await next();
});
authorization2Route.use("/roles/*", async (c, next) => {
  const auth = await authenticate(c);
  if (!auth.isAdmin) return c.json({ status: 401, message: "Unauthorized" }, 401);
  await next();
});
authorization2Route.use("/roles", async (c, next) => {
  const auth = await authenticate(c);
  if (!auth.isAdmin) return c.json({ status: 401, message: "Unauthorized" }, 401);
  await next();
});

async function subjectsWithTokens(env: Env) {
  const { results } = await env.DB.prepare("SELECT id, name, role_names, notes FROM auth_subjects").all<
    { id: string; name: string; role_names: string; notes: string | null }
  >();
  return Promise.all(
    (results ?? []).map(async (row) => ({
      _id: row.id,
      name: row.name,
      roles: JSON.parse(row.role_names) as string[],
      notes: row.notes,
      accessToken: await deriveAccessToken(env, row.id, row.name),
    }))
  );
}

authorization2Route.get("/subjects", async (c) => {
  return c.json(await subjectsWithTokens(c.env));
});

authorization2Route.post("/subjects", async (c) => {
  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  const name = String(body.name ?? "").trim();
  const roles = normalizeArrayField(body, "roles");
  if (!name) return c.json({ status: 400, message: "name is required" }, 400);

  const id = generateId();
  await c.env.DB.prepare("INSERT INTO auth_subjects (id, name, role_names, notes) VALUES (?, ?, ?, ?)")
    .bind(id, name, JSON.stringify(roles), (body.notes as string) || null)
    .run();
  return c.json({ _id: id, name, roles, accessToken: await deriveAccessToken(c.env, id, name) }, 201);
});

authorization2Route.put("/subjects", async (c) => {
  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  const id = String(body._id ?? "");
  if (!id) return c.json({ status: 400, message: "_id is required" }, 400);
  const name = String(body.name ?? "").trim();
  const roles = normalizeArrayField(body, "roles");
  await c.env.DB.prepare("UPDATE auth_subjects SET name = ?, role_names = ?, notes = ? WHERE id = ?")
    .bind(name, JSON.stringify(roles), (body.notes as string) || null, id)
    .run();
  return c.json({ _id: id, name, roles, accessToken: await deriveAccessToken(c.env, id, name) });
});

authorization2Route.delete("/subjects/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM auth_subjects WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({});
});

authorization2Route.get("/roles", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, permissions, notes FROM auth_roles ORDER BY name").all<
    { id: string | null; name: string; permissions: string; notes: string | null }
  >();
  return c.json((results ?? []).map((r) => ({ _id: r.id ?? undefined, name: r.name, permissions: JSON.parse(r.permissions), notes: r.notes })));
});

authorization2Route.post("/roles", async (c) => {
  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  const name = String(body.name ?? "").trim();
  const permissions = normalizeArrayField(body, "permissions");
  if (!name) return c.json({ status: 400, message: "name is required" }, 400);

  const id = generateId();
  await c.env.DB.prepare("INSERT INTO auth_roles (id, name, permissions, notes) VALUES (?, ?, ?, ?)")
    .bind(id, name, JSON.stringify(permissions), (body.notes as string) || null)
    .run();
  return c.json({ _id: id, name, permissions, notes: (body.notes as string) || null }, 201);
});

authorization2Route.put("/roles", async (c) => {
  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  const id = String(body._id ?? "");
  if (!id) return c.json({ status: 400, message: "_id is required" }, 400);
  const name = String(body.name ?? "").trim();
  const permissions = normalizeArrayField(body, "permissions");
  await c.env.DB.prepare("UPDATE auth_roles SET name = ?, permissions = ?, notes = ? WHERE id = ?")
    .bind(name, JSON.stringify(permissions), (body.notes as string) || null, id)
    .run();
  return c.json({ _id: id, name, permissions, notes: (body.notes as string) || null });
});

authorization2Route.delete("/roles/:id", async (c) => {
  // Built-in default roles have id = NULL and are never targeted by this
  // route (the UI has no _id to send for them), so this only ever removes
  // user-created roles.
  await c.env.DB.prepare("DELETE FROM auth_roles WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({});
});

authorization2Route.get("/permissions", async (c) => {
  const auth = await authenticate(c);
  if (!auth.isAdmin) return c.json({ status: 401, message: "Unauthorized" }, 401);
  return c.json([]);
});

authorization2Route.get("/permissions/trie", async (c) => {
  const auth = await authenticate(c);
  if (!auth.isAdmin) return c.json({ status: 401, message: "Unauthorized" }, 401);
  return c.json({});
});
