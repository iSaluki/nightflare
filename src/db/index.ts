import { Collection, dateFromFields, type DocBase } from "./collection";

export function entriesCollection(db: D1Database): Collection {
  return new Collection(db, {
    table: "entries",
    indexedColumns: new Set(["date", "type", "device"]),
    deriveDate: (doc) => dateFromFields(doc, "date", "dateString"),
    extraColumns: (doc) => ({
      type: (doc.type as string) ?? "sgv",
      device: (doc.device as string) ?? null,
    }),
  });
}

export function treatmentsCollection(db: D1Database): Collection {
  return new Collection(db, {
    table: "treatments",
    indexedColumns: new Set(["date", "eventType", "device"]),
    deriveDate: (doc) => dateFromFields(doc, "created_at", "date", "timestamp"),
    extraColumns: (doc) => ({
      eventType: (doc.eventType as string) ?? null,
      device: (doc.device as string) ?? null,
    }),
  });
}

export function devicestatusCollection(db: D1Database): Collection {
  return new Collection(db, {
    table: "devicestatus",
    indexedColumns: new Set(["date", "device"]),
    deriveDate: (doc) => dateFromFields(doc, "created_at", "date"),
    extraColumns: (doc) => ({
      device: (doc.device as string) ?? null,
    }),
  });
}

export function profilesCollection(db: D1Database): Collection {
  return new Collection(db, {
    table: "profiles",
    indexedColumns: new Set(["date"]),
    deriveDate: (doc) => dateFromFields(doc, "startDate", "created_at", "date"),
  });
}

export function foodCollection(db: D1Database): Collection {
  return new Collection(db, {
    table: "food",
    indexedColumns: new Set(["date", "category"]),
    deriveDate: () => Date.now(),
    extraColumns: (doc) => ({
      category: (doc.category as string) ?? null,
    }),
  });
}

export function activityCollection(db: D1Database): Collection {
  return new Collection(db, {
    table: "activity",
    indexedColumns: new Set(["date"]),
    deriveDate: (doc) => dateFromFields(doc, "created_at", "eventTime", "date"),
  });
}

export type { DocBase };
