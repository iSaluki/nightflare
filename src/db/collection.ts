import { generateId } from "../lib/id";
import { parseMongoFind } from "../lib/mongo-query";

export interface DocBase {
  _id?: string;
  [key: string]: unknown;
}

interface CollectionOptions {
  table: string;
  /** Table columns that are safe to reference directly (as opposed to via
   * json_extract) in find[] queries and sorting. */
  indexedColumns: Set<string>;
  /** Extracts the epoch-ms sort date for a document being inserted. */
  deriveDate: (doc: DocBase) => number;
  /** Extra indexed columns to populate on insert, beyond id/date/data. */
  extraColumns?: (doc: DocBase) => Record<string, string | number | null>;
}

function dateFromFields(doc: DocBase, ...fields: string[]): number {
  for (const f of fields) {
    const v = doc[f];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const parsed = Date.parse(v);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return Date.now();
}

export { dateFromFields };

export class Collection {
  constructor(private db: D1Database, private opts: CollectionOptions) {}

  async insert(doc: DocBase): Promise<DocBase> {
    const id = typeof doc._id === "string" && doc._id.length > 0 ? doc._id : generateId();
    const date = this.opts.deriveDate(doc);
    const record = { ...doc, _id: id };
    const extra = this.opts.extraColumns?.(record) ?? {};
    const extraKeys = Object.keys(extra);
    const columns = ["id", "date", "data", ...extraKeys];
    const placeholders = columns.map(() => "?").join(",");
    // OR IGNORE: uploaders (and import jobs resumed after an interruption)
    // routinely retry a POST for a document whose _id already made it in on
    // a prior attempt -- that should be a harmless no-op, not a UNIQUE
    // constraint error surfaced back as a 500.
    await this.db
      .prepare(`INSERT OR IGNORE INTO ${this.opts.table} (${columns.join(",")}) VALUES (${placeholders})`)
      .bind(id, date, JSON.stringify(record), ...extraKeys.map((k) => extra[k]))
      .run();
    return record;
  }

  async insertMany(docs: DocBase[]): Promise<DocBase[]> {
    const out: DocBase[] = [];
    for (const doc of docs) out.push(await this.insert(doc));
    return out;
  }

  async list(searchParams: URLSearchParams, opts: { defaultLimit?: number; maxLimit?: number } = {}): Promise<DocBase[]> {
    const { where, bindings } = parseMongoFind(searchParams, this.opts.indexedColumns);
    const requestedCount = Number(searchParams.get("count"));
    const maxLimit = opts.maxLimit ?? 1000;
    const limit = Math.min(Number.isFinite(requestedCount) && requestedCount > 0 ? requestedCount : opts.defaultLimit ?? 10, maxLimit);
    const { results } = await this.db
      .prepare(`SELECT data FROM ${this.opts.table} WHERE ${where} ORDER BY date DESC LIMIT ?`)
      .bind(...bindings, limit)
      .all<{ data: string }>();
    return (results ?? []).map((r) => JSON.parse(r.data));
  }

  async getById(id: string): Promise<DocBase | null> {
    const row = await this.db.prepare(`SELECT data FROM ${this.opts.table} WHERE id = ?`).bind(id).first<{ data: string }>();
    return row ? JSON.parse(row.data) : null;
  }

  async update(id: string, doc: DocBase): Promise<DocBase> {
    const record = { ...doc, _id: id };
    const date = this.opts.deriveDate(record);
    const extra = this.opts.extraColumns?.(record) ?? {};
    const extraKeys = Object.keys(extra);
    const setClause = ["date = ?", "data = ?", ...extraKeys.map((k) => `${k} = ?`)].join(", ");
    await this.db
      .prepare(`UPDATE ${this.opts.table} SET ${setClause} WHERE id = ?`)
      .bind(date, JSON.stringify(record), ...extraKeys.map((k) => extra[k]), id)
      .run();
    return record;
  }

  async deleteById(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM ${this.opts.table} WHERE id = ?`).bind(id).run();
  }

  async deleteWhere(searchParams: URLSearchParams): Promise<number> {
    const { where, bindings } = parseMongoFind(searchParams, this.opts.indexedColumns);
    const res = await this.db.prepare(`DELETE FROM ${this.opts.table} WHERE ${where}`).bind(...bindings).run();
    return res.meta.changes ?? 0;
  }
}
