import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { resolveCredentials, canRead as authCanRead, canWrite as authCanWrite, canWriteTreatments } from "../lib/auth";
import { entriesCollection, treatmentsCollection, devicestatusCollection, profilesCollection, foodCollection, activityCollection } from "../db";
import type { Collection, DocBase } from "../db/collection";

interface ClientMessage {
  t: "event";
  ns: string;
  event: string;
  data: unknown;
  ackId?: number;
}

interface SocketAuth {
  read: boolean;
  write: boolean;
  write_treatment: boolean;
}

const COLLECTION_FACTORIES: Record<string, (db: D1Database) => Collection> = {
  entries: entriesCollection,
  treatments: treatmentsCollection,
  devicestatus: devicestatusCollection,
  profile: profilesCollection,
  food: foodCollection,
  activity: activityCollection,
};

/** Reshapes a stored entry into the slim {mgdl,mills,...} shape Nightscout's
 * server sends over the wire (lib/data/dataloader.js loadEntries) — the
 * client's chart/sandbox code reads `entry.mgdl`, not `entry.sgv`. */
function shapeEntryForWire(doc: DocBase): DocBase {
  const mills = Number(doc.date) || Date.now();
  if (doc.type === "mbg") {
    return { _id: doc._id, mgdl: Number(doc.mbg ?? doc.sgv), mills, device: doc.device, type: "mbg" };
  }
  if (doc.type === "cal") {
    return { _id: doc._id, mills, scale: doc.scale, intercept: doc.intercept, slope: doc.slope, type: "cal" };
  }
  return {
    _id: doc._id,
    mgdl: Number(doc.sgv),
    mills,
    device: doc.device,
    direction: doc.direction,
    filtered: doc.filtered,
    unfiltered: doc.unfiltered,
    noise: doc.noise,
    rssi: doc.rssi,
    type: "sgv",
  };
}

function deriveMills(collection: string, doc: DocBase): number {
  if (collection === "entries") {
    const date = Number(doc.date);
    if (Number.isFinite(date)) return date;
  }
  if (typeof doc.created_at === "string") {
    const parsed = Date.parse(doc.created_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const date = Number(doc.date);
  return Number.isFinite(date) ? date : Date.now();
}

/** One instance per deployed site (a single fixed DO id). Speaks a small
 * JSON-envelope protocol over a plain WebSocket that mirrors just enough of
 * socket.io's client-visible surface (see public/io-shim.js) for
 * Nightscout's *unmodified* vendored client bundle to work: 'authorize'
 * handshake, an initial full 'dataUpdate' push plus deltas on every write,
 * 'loadRetro'/'retroUpdate' for chart scroll-back, and 'dbAdd'/'dbUpdate'/
 * 'dbUpdateUnset' for the inline chart editor. */
export class RealtimeHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // dead socket; hibernation API drops it on next GC
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t !== "event") return;

    if (msg.event === "authorize") {
      await this.handleAuthorize(ws, msg);
      return;
    }
    if (msg.event === "loadRetro") {
      const retro = await this.buildRetroData();
      if (msg.ackId !== undefined) this.send(ws, { t: "ack", ackId: msg.ackId, data: { result: "success" } });
      this.send(ws, { t: "event", ns: msg.ns, event: "retroUpdate", data: retro });
      return;
    }
    if (msg.event === "dbAdd" || msg.event === "dbUpdate" || msg.event === "dbUpdateUnset") {
      const attachment = (ws.deserializeAttachment() as { auth?: SocketAuth } | null) ?? null;
      const result = await this.handleDbWrite(msg.event, msg.data, attachment?.auth);
      if (msg.ackId !== undefined) this.send(ws, { t: "ack", ackId: msg.ackId, data: result });
      return;
    }
    if (msg.event === "subscribe") {
      // Alarm namespace: we don't implement server-pushed alarm sync across
      // viewers, but ack so the client doesn't think the connection is dead.
      if (msg.ackId !== undefined) this.send(ws, { t: "ack", ackId: msg.ackId, data: { result: "success" } });
      return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    if (!wasClean) {
      try {
        ws.close(code, reason);
      } catch {
        // already closed
      }
    }
  }

  private async handleAuthorize(ws: WebSocket, msg: ClientMessage): Promise<void> {
    const data = (msg.data as { secret?: string; token?: string; history?: number }) ?? {};
    const auth = await resolveCredentials(this.env, { secretHash: data.secret, token: data.token });
    const socketAuth: SocketAuth = {
      read: authCanRead(auth),
      write: authCanWrite(auth),
      write_treatment: canWriteTreatments(auth) || authCanWrite(auth),
    };
    ws.serializeAttachment({ auth: socketAuth });

    this.send(ws, { t: "event", ns: msg.ns, event: "connected", data: null });

    if (socketAuth.read) {
      const history = typeof data.history === "number" && data.history > 0 ? data.history : 48;
      const initial = await this.buildInitialData(history);
      this.send(ws, { t: "event", ns: msg.ns, event: "dataUpdate", data: initial });
    }

    if (msg.ackId !== undefined) this.send(ws, { t: "ack", ackId: msg.ackId, data: socketAuth });
  }

  private async buildInitialData(historyHours: number) {
    const cutoff = Date.now() - historyHours * 60 * 60 * 1000;
    const db = this.env.DB;

    const entriesRes = await db.prepare("SELECT data FROM entries WHERE date >= ? ORDER BY date ASC").bind(cutoff).all<{
      data: string;
    }>();
    const sgvs: DocBase[] = [];
    const mbgs: DocBase[] = [];
    const cals: DocBase[] = [];
    for (const row of entriesRes.results ?? []) {
      const doc = JSON.parse(row.data) as DocBase;
      const shaped = shapeEntryForWire(doc);
      if (doc.type === "mbg") mbgs.push(shaped);
      else if (doc.type === "cal") cals.push(shaped);
      else sgvs.push(shaped);
    }

    const treatmentsRes = await db.prepare("SELECT data FROM treatments WHERE date >= ? ORDER BY date ASC").bind(cutoff).all<{
      data: string;
    }>();
    const treatments = (treatmentsRes.results ?? []).map((row) => {
      const doc = JSON.parse(row.data) as DocBase;
      return { ...doc, mills: deriveMills("treatments", doc) };
    });

    const devicestatusRes = await db
      .prepare("SELECT data FROM devicestatus WHERE date >= ? ORDER BY date ASC")
      .bind(cutoff)
      .all<{ data: string }>();
    const devicestatus = (devicestatusRes.results ?? []).map((row) => {
      const doc = JSON.parse(row.data) as DocBase;
      return { ...doc, mills: deriveMills("devicestatus", doc) };
    });

    const profilesRes = await db.prepare("SELECT data FROM profiles ORDER BY date DESC LIMIT 10").all<{ data: string }>();
    const profiles = (profilesRes.results ?? []).map((row) => JSON.parse(row.data));

    return { delta: false, lastUpdated: Date.now(), sgvs, mbgs, cals, treatments, devicestatus, profiles };
  }

  private async buildRetroData() {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const rows = await this.env.DB.prepare("SELECT data FROM devicestatus WHERE date >= ? ORDER BY date ASC")
      .bind(cutoff)
      .all<{ data: string }>();
    const devicestatus = (rows.results ?? []).map((row) => {
      const doc = JSON.parse(row.data) as DocBase;
      return { ...doc, mills: deriveMills("devicestatus", doc) };
    });
    return { devicestatus };
  }

  private buildDelta(collection: string, op: "create" | "update" | "delete", doc: DocBase): Record<string, unknown> | null {
    const base = { delta: true, lastUpdated: Date.now() };

    if (collection === "entries") {
      // The client's merge algorithm (nsArrayDiff) has no concept of
      // removal for sgvs/mbgs/cals, so a delete just isn't representable
      // as a live push — the next full reload will reflect it.
      if (op === "delete") return null;
      const key = doc.type === "mbg" ? "mbgs" : doc.type === "cal" ? "cals" : "sgvs";
      return { ...base, [key]: [shapeEntryForWire(doc)] };
    }

    if (collection === "treatments") {
      if (op === "delete") return { ...base, treatments: [{ _id: doc._id, action: "remove" }] };
      const withMills = { ...doc, mills: deriveMills("treatments", doc) };
      return { ...base, treatments: [op === "update" ? { ...withMills, action: "update" } : withMills] };
    }

    if (collection === "devicestatus") {
      if (op === "delete") return null;
      return { ...base, devicestatus: [{ ...doc, mills: deriveMills("devicestatus", doc) }] };
    }

    if (collection === "profile") {
      if (op === "delete") return null;
      return { ...base, profiles: [doc] };
    }

    // food/activity aren't part of stock Nightscout's live dataUpdate
    // protocol either — clients reload them on demand via REST.
    return null;
  }

  private broadcastToReaders(message: Record<string, unknown>): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { auth?: SocketAuth } | null;
      if (attachment?.auth?.read) this.send(ws, message);
    }
  }

  /** Called via RPC from REST routes right after a successful write. */
  async notify(payload: { collection: string; op: "create" | "update" | "delete"; doc: DocBase }): Promise<void> {
    const delta = this.buildDelta(payload.collection, payload.op, payload.doc);
    if (!delta) return;
    this.broadcastToReaders({ t: "event", ns: "", event: "dataUpdate", data: delta });
  }

  private async handleDbWrite(
    event: string,
    rawData: unknown,
    socketAuth: SocketAuth | undefined
  ): Promise<unknown> {
    const data = (rawData as { collection?: string; _id?: string; data?: DocBase | DocBase[] }) ?? {};
    const factory = data.collection ? COLLECTION_FACTORIES[data.collection] : undefined;
    if (!factory || !data.collection) return { result: "Wrong collection" };
    if (!socketAuth) return { result: "Not authorized" };

    const needsWrite = data.collection === "treatments" ? socketAuth.write_treatment : socketAuth.write;
    if (!needsWrite) return { result: "Not permitted" };

    const col = factory(this.env.DB);

    if (event === "dbAdd") {
      const items = Array.isArray(data.data) ? data.data : [data.data as DocBase];
      const created: DocBase[] = [];
      for (const item of items) {
        const doc = await col.insert(item);
        created.push(doc);
        await this.notify({ collection: data.collection, op: "create", doc });
      }
      return created;
    }

    if (!data._id) return { result: "Missing _id" };
    const existing = await col.getById(String(data._id));
    if (!existing) return { result: "Not found" };

    if (event === "dbUpdate") {
      const merged = { ...existing, ...(data.data as DocBase) };
      const saved = await col.update(String(data._id), merged);
      await this.notify({ collection: data.collection, op: "update", doc: saved });
      return { result: "success" };
    }

    if (event === "dbUpdateUnset") {
      const merged: DocBase = { ...existing };
      for (const key of Object.keys((data.data as DocBase) ?? {})) delete merged[key];
      const saved = await col.update(String(data._id), merged);
      await this.notify({ collection: data.collection, op: "update", doc: saved });
      return { result: "success" };
    }

    return { result: "Unknown event" };
  }
}
