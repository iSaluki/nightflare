import { Hono } from "hono";
import type { Env } from "../types";
import { authenticate } from "../lib/auth";
import { sha1Hex } from "../lib/crypto";
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

// Subject/role (API client) management lives at /api/v2/authorization/* —
// see routes/authorization2.ts — matching the contract Nightscout's real,
// vendored admin UI (admin_plugins/subjects.js, roles.js) already expects.
