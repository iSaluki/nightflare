import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { entriesCollection, treatmentsCollection, devicestatusCollection, profilesCollection, foodCollection, activityCollection } from "../db";
import type { Collection, DocBase } from "../db/collection";
import { generateId } from "../lib/id";

const PAGE_SIZE = 500;
// These collections don't have a reliable `date` field to cursor on across
// arbitrary source deployments, and are small by nature — fetch once.
const SINGLE_PAGE_COLLECTIONS = new Set(["profile", "food"]);

interface SourceRole {
  name: string;
  permissions: string[];
  notes?: string | null;
}

interface SourceSubject {
  _id?: string;
  name: string;
  roles: string[];
  notes?: string | null;
}

const COLLECTION_FACTORIES: Record<string, (db: D1Database) => Collection> = {
  entries: entriesCollection,
  treatments: treatmentsCollection,
  devicestatus: devicestatusCollection,
  profile: profilesCollection,
  food: foodCollection,
  activity: activityCollection,
};

interface ImportState {
  jobId: string;
  sourceUrl: string;
  apiSecretHash: string | null;
  sourceToken: string | null;
  collections: string[];
  collectionIndex: number;
  cursor: number | null;
  imported: Record<string, number>;
}

export class ImportJob extends DurableObject<Env> {
  async start(params: {
    jobId: string;
    sourceUrl: string;
    apiSecretHash: string | null;
    sourceToken: string | null;
    collections: string[];
  }): Promise<void> {
    const state: ImportState = {
      jobId: params.jobId,
      sourceUrl: params.sourceUrl.replace(/\/$/, ""),
      apiSecretHash: params.apiSecretHash,
      sourceToken: params.sourceToken,
      collections: params.collections,
      collectionIndex: 0,
      cursor: null,
      imported: {},
    };
    await this.ctx.storage.put("state", state);
    await this.updateJobRow(state, "running");
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async updateJobRow(state: ImportState, status: string, error?: string): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE import_jobs SET status = ?, progress = ?, error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    )
      .bind(status, JSON.stringify(state.imported), error ?? null, state.jobId)
      .run();
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<ImportState>("state");
    if (!state) return;

    if (state.collectionIndex >= state.collections.length) {
      await this.updateJobRow(state, "completed");
      return;
    }

    const collectionName = state.collections[state.collectionIndex];
    const factory = COLLECTION_FACTORIES[collectionName];
    if (!factory && collectionName !== "subjects") {
      state.collectionIndex += 1;
      state.cursor = null;
      await this.ctx.storage.put("state", state);
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }

    const headers: Record<string, string> = {};
    if (state.apiSecretHash) headers["api-secret"] = state.apiSecretHash;

    try {
      if (collectionName === "subjects") {
        const counts = await this.importSubjectsAndRoles(state, headers);
        state.imported.roles = (state.imported.roles ?? 0) + counts.roles;
        state.imported.subjects = (state.imported.subjects ?? 0) + counts.subjects;
        state.collectionIndex += 1;
        state.cursor = null;
      } else if (factory) {
        const singlePage = SINGLE_PAGE_COLLECTIONS.has(collectionName);
        const url = new URL(`${state.sourceUrl}/api/v1/${collectionName}.json`);
        url.searchParams.set("count", String(singlePage ? 1000 : PAGE_SIZE));
        if (!singlePage && state.cursor !== null) {
          url.searchParams.set("find[date][$lt]", String(state.cursor));
        }
        // A subject/access token (Nightscout's `?token=` follower-auth scheme)
        // is a more appropriate credential to hand an import job than the
        // source site's master secret, so support it alongside apiSecretHash.
        if (state.sourceToken) url.searchParams.set("token", state.sourceToken);

        const res = await fetch(url.toString(), { headers });
        if (!res.ok) {
          const bodySnippet = (await res.text().catch(() => "")).slice(0, 200);
          throw new Error(`source returned ${res.status} for ${collectionName}${bodySnippet ? `: ${bodySnippet}` : ""}`);
        }
        const batch = (await res.json()) as DocBase[];

        if (Array.isArray(batch) && batch.length > 0) {
          await factory(this.env.DB).insertMany(batch);
          state.imported[collectionName] = (state.imported[collectionName] ?? 0) + batch.length;

          if (!singlePage) {
            const dates = batch.map((d) => Number(d.date)).filter((n) => Number.isFinite(n));
            const minDate = dates.length ? Math.min(...dates) : null;
            state.cursor = minDate !== null ? minDate - 1 : null;
          }
        }

        const exhausted = singlePage || !Array.isArray(batch) || batch.length < PAGE_SIZE;
        if (exhausted) {
          state.collectionIndex += 1;
          state.cursor = null;
        }
      }

      await this.ctx.storage.put("state", state);
      await this.updateJobRow(state, "running");
      await this.ctx.storage.setAlarm(Date.now());
    } catch (err) {
      await this.updateJobRow(state, "failed", err instanceof Error ? err.message : String(err));
      // Don't reschedule; the job stays "failed" for the admin UI to inspect.
    }
  }

  // Subjects/roles live behind /api/v2/authorization/* (admin-only), not the
  // generic v1 collection API the rest of this job pulls from, and they're
  // small lists -- fetched and written in one shot rather than paginated.
  // Recreating a source subject issues it a brand-new access token derived
  // from *this* deployment's id + API_SECRET (deriveAccessToken is
  // deterministic per subject id + secret, and the two deployments
  // necessarily have different secrets) -- existing shared follower links
  // built on the source's tokens won't carry over, only the subject/role
  // records themselves.
  private async importSubjectsAndRoles(
    state: ImportState,
    headers: Record<string, string>
  ): Promise<{ roles: number; subjects: number }> {
    const rolesUrl = new URL(`${state.sourceUrl}/api/v2/authorization/roles`);
    if (state.sourceToken) rolesUrl.searchParams.set("token", state.sourceToken);
    const rolesRes = await fetch(rolesUrl.toString(), { headers });
    if (!rolesRes.ok) {
      const bodySnippet = (await rolesRes.text().catch(() => "")).slice(0, 200);
      throw new Error(`source returned ${rolesRes.status} for roles${bodySnippet ? `: ${bodySnippet}` : ""}`);
    }
    const sourceRoles = (await rolesRes.json()) as SourceRole[];

    const { results: existingRoleRows } = await this.env.DB.prepare("SELECT name FROM auth_roles").all<{ name: string }>();
    const existingRoleNames = new Set((existingRoleRows ?? []).map((r) => r.name));

    let roleCount = 0;
    for (const role of sourceRoles) {
      // Never clobber a same-named role that already exists (built-in
      // defaults every deployment ships with, or one already imported).
      if (!role.name || existingRoleNames.has(role.name)) continue;
      await this.env.DB.prepare("INSERT INTO auth_roles (id, name, permissions, notes) VALUES (?, ?, ?, ?)")
        .bind(generateId(), role.name, JSON.stringify(role.permissions ?? []), role.notes ?? null)
        .run();
      existingRoleNames.add(role.name);
      roleCount += 1;
    }

    const subjectsUrl = new URL(`${state.sourceUrl}/api/v2/authorization/subjects`);
    if (state.sourceToken) subjectsUrl.searchParams.set("token", state.sourceToken);
    const subjectsRes = await fetch(subjectsUrl.toString(), { headers });
    if (!subjectsRes.ok) {
      const bodySnippet = (await subjectsRes.text().catch(() => "")).slice(0, 200);
      throw new Error(`source returned ${subjectsRes.status} for subjects${bodySnippet ? `: ${bodySnippet}` : ""}`);
    }
    const sourceSubjects = (await subjectsRes.json()) as SourceSubject[];

    let subjectCount = 0;
    for (const subject of sourceSubjects) {
      if (!subject.name) continue;
      const id = typeof subject._id === "string" && subject._id.length > 0 ? subject._id : generateId();
      // OR IGNORE: safe to re-run this collection (e.g. after an
      // interrupted job resumes) without erroring on subjects already
      // brought in by a prior attempt.
      await this.env.DB.prepare("INSERT OR IGNORE INTO auth_subjects (id, name, role_names, notes) VALUES (?, ?, ?, ?)")
        .bind(id, subject.name, JSON.stringify(subject.roles ?? []), subject.notes ?? null)
        .run();
      subjectCount += 1;
    }

    return { roles: roleCount, subjects: subjectCount };
  }
}
