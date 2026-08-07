import { Hono } from "hono";
import type { Env } from "../types";
import { authenticate } from "../lib/auth";
import { sha1Hex, sha256Hex, randomToken } from "../lib/crypto";
import { generateId } from "../lib/id";

export const adminRoute = new Hono<{ Bindings: Env }>();

adminRoute.use("*", async (c, next) => {
  const auth = await authenticate(c);
  if (!auth.isAdmin) return c.json({ status: 401, message: "Admin access required" }, 401);
  await next();
});

const IMPORTABLE_COLLECTIONS = ["entries", "treatments", "devicestatus", "profile", "food", "activity"];

// --- Import from another Nightscout instance -------------------------------

adminRoute.post("/import", async (c) => {
  const body = await c.req.json<{ sourceUrl?: string; apiSecret?: string; collections?: string[] }>();
  if (!body.sourceUrl) return c.json({ status: 400, message: "sourceUrl is required" }, 400);

  let sourceUrl: string;
  try {
    sourceUrl = new URL(body.sourceUrl).toString();
  } catch {
    return c.json({ status: 400, message: "sourceUrl must be a valid URL" }, 400);
  }

  const collections = (body.collections && body.collections.length > 0 ? body.collections : IMPORTABLE_COLLECTIONS).filter(
    (name) => IMPORTABLE_COLLECTIONS.includes(name)
  );
  if (collections.length === 0) return c.json({ status: 400, message: "no valid collections requested" }, 400);

  const jobId = generateId();
  await c.env.DB.prepare(
    "INSERT INTO import_jobs (id, source_url, status, collections, progress) VALUES (?, ?, 'pending', ?, '{}')"
  )
    .bind(jobId, sourceUrl, JSON.stringify(collections))
    .run();

  const apiSecretHash = body.apiSecret ? await sha1Hex(body.apiSecret) : null;
  const stub = c.env.IMPORT_JOB.get(c.env.IMPORT_JOB.idFromName(jobId));
  await stub.start({ jobId, sourceUrl, apiSecretHash, collections });

  return c.json({ jobId, status: "running", sourceUrl, collections }, 202);
});

adminRoute.get("/import/:jobId", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id, source_url, status, collections, progress, error, created_at, updated_at FROM import_jobs WHERE id = ?"
  )
    .bind(c.req.param("jobId"))
    .first<Record<string, string>>();
  if (!row) return c.json({ status: 404, message: "Not found" }, 404);
  return c.json({
    jobId: row.id,
    sourceUrl: row.source_url,
    status: row.status,
    collections: JSON.parse(row.collections),
    progress: row.progress ? JSON.parse(row.progress) : {},
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

adminRoute.get("/import", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, source_url, status, collections, progress, error, created_at, updated_at FROM import_jobs ORDER BY created_at DESC LIMIT 50"
  ).all<Record<string, string>>();
  return c.json(
    (results ?? []).map((row) => ({
      jobId: row.id,
      sourceUrl: row.source_url,
      status: row.status,
      collections: JSON.parse(row.collections),
      progress: row.progress ? JSON.parse(row.progress) : {},
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  );
});

// --- Subjects & roles (API client management) ------------------------------

adminRoute.get("/subjects", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, role_names, notes, created_at FROM auth_subjects").all<
    Record<string, string>
  >();
  return c.json(
    (results ?? []).map(({ role_names, ...r }) => ({ ...r, roles: JSON.parse(role_names) }))
  );
});

adminRoute.post("/subjects", async (c) => {
  const body = await c.req.json<{ name?: string; roles?: string[]; notes?: string }>();
  if (!body.name || !body.roles?.length) return c.json({ status: 400, message: "name and roles are required" }, 400);

  const id = generateId();
  const accessToken = randomToken();
  const accessTokenHash = await sha256Hex(accessToken);
  await c.env.DB.prepare("INSERT INTO auth_subjects (id, name, role_names, access_token_hash, notes) VALUES (?, ?, ?, ?, ?)")
    .bind(id, body.name, JSON.stringify(body.roles), accessTokenHash, body.notes ?? null)
    .run();

  // The plaintext token is only ever shown once, at creation time.
  return c.json({ id, name: body.name, roles: body.roles, accessToken }, 201);
});

adminRoute.delete("/subjects/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM auth_subjects WHERE id = ?").bind(c.req.param("id")).run();
  return c.body(null, 204);
});

adminRoute.get("/roles", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT name, permissions, notes FROM auth_roles").all<Record<string, string>>();
  return c.json((results ?? []).map((r) => ({ ...r, permissions: JSON.parse(r.permissions) })));
});

adminRoute.post("/roles", async (c) => {
  const body = await c.req.json<{ name?: string; permissions?: string[]; notes?: string }>();
  if (!body.name || !body.permissions?.length) return c.json({ status: 400, message: "name and permissions are required" }, 400);
  await c.env.DB.prepare("INSERT OR REPLACE INTO auth_roles (name, permissions, notes) VALUES (?, ?, ?)")
    .bind(body.name, JSON.stringify(body.permissions), body.notes ?? null)
    .run();
  return c.json({ name: body.name, permissions: body.permissions, notes: body.notes ?? null }, 201);
});
