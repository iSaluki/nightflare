import type { Env } from "../types";
import type { DocBase } from "../db/collection";

/** Single fixed instance name — one Nightflare deployment == one "site",
 * same as one Nightscout install serves one person's data. */
export function realtimeStub(env: Env) {
  const id = env.REALTIME.idFromName("site");
  return env.REALTIME.get(id);
}

export async function notifyChange(
  env: Env,
  collection: string,
  op: "create" | "update" | "delete",
  doc: DocBase
): Promise<void> {
  try {
    await realtimeStub(env).notify({ collection, op, doc });
  } catch {
    // best-effort; a missed live-update shouldn't fail the API request
  }
}
