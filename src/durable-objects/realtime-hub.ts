import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

/** One instance per deployed site (a single fixed DO id, since Nightflare
 * is a single-tenant-per-deployment app like Nightscout). Holds hibernating
 * WebSocket connections for every open dashboard tab and fans out a small
 * "something changed" message whenever the REST API stores new data —
 * replaces the socket.io "dataUpdate" push that stock Nightscout uses. */
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

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Clients don't send meaningful data; this exists only so hibernation
    // can wake the DO if we ever need bidirectional messages.
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

  /** Invoked via RPC from API routes after a successful write. */
  async broadcast(payload: { collection: string; op: "create" | "update" | "delete" }): Promise<void> {
    const message = JSON.stringify({ ...payload, ts: Date.now() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // dead socket; hibernation API will drop it on next GC
      }
    }
  }
}
