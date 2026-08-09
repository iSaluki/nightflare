import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { entriesCollection, treatmentsCollection, devicestatusCollection, profilesCollection, foodCollection, activityCollection } from "../db";
import type { Collection, DocBase } from "../db/collection";

const PAGE_SIZE = 500;
// These collections don't have a reliable `date` field to cursor on across
// arbitrary source deployments, and are small by nature — fetch once.
const SINGLE_PAGE_COLLECTIONS = new Set(["profile", "food"]);

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
    if (!factory) {
      state.collectionIndex += 1;
      state.cursor = null;
      await this.ctx.storage.put("state", state);
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }

    try {
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

      const headers: Record<string, string> = {};
      if (state.apiSecretHash) headers["api-secret"] = state.apiSecretHash;

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

      await this.ctx.storage.put("state", state);
      await this.updateJobRow(state, "running");
      await this.ctx.storage.setAlarm(Date.now());
    } catch (err) {
      await this.updateJobRow(state, "failed", err instanceof Error ? err.message : String(err));
      // Don't reschedule; the job stays "failed" for the admin UI to inspect.
    }
  }
}
