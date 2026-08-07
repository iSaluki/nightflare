const OPS: Record<string, string> = {
  $gte: ">=",
  $gt: ">",
  $lte: "<=",
  $lt: "<",
  $ne: "!=",
  $eq: "=",
};

export interface ParsedQuery {
  where: string;
  bindings: unknown[];
}

/** Parses Nightscout's Mongo-shaped `find[field][$op]=value` query params
 * (as used by every official client/report, e.g. `find[date][$gte]=...`,
 * `find[type]=sgv`) into a SQL WHERE fragment.
 *
 * `indexedColumns` names real table columns to compare directly (fast,
 * sorted); anything else falls back to `json_extract(data, '$.field')` so
 * arbitrary uploader-specific fields remain queryable, at the cost of a
 * full scan. */
export function parseMongoFind(searchParams: URLSearchParams, indexedColumns: Set<string>): ParsedQuery {
  const fields = new Map<string, Map<string, string>>();

  for (const [key, value] of searchParams.entries()) {
    const match = key.match(/^find\[([^\]]+)\](?:\[([^\]]+)\])?$/);
    if (!match) continue;
    const [, field, op] = match;
    if (!fields.has(field)) fields.set(field, new Map());
    fields.get(field)!.set(op ?? "$eq", value);
  }

  const clauses: string[] = [];
  const bindings: unknown[] = [];

  for (const [field, ops] of fields) {
    const column = indexedColumns.has(field) ? field : `json_extract(data, '$.${field}')`;
    for (const [op, rawValue] of ops) {
      const sqlOp = OPS[op] ?? "=";
      const numeric = Number(rawValue);
      const value = Number.isFinite(numeric) && rawValue.trim() !== "" ? numeric : rawValue;
      clauses.push(`${column} ${sqlOp} ?`);
      bindings.push(value);
    }
  }

  return { where: clauses.length ? clauses.join(" AND ") : "1=1", bindings };
}
