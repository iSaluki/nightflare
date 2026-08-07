/** Generates a 24-char hex id shaped like a Mongo ObjectId, since every
 * Nightscout client (uploaders, followers, xDrip+, Loop, AAPS...) expects
 * `_id` to look like one. Not a real ObjectId (no machine/pid component,
 * just a timestamp prefix + random tail), but format-compatible. */
export function generateId(date: number = Date.now()): string {
  const timestamp = Math.floor(date / 1000)
    .toString(16)
    .padStart(8, "0");
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const tail = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  return timestamp + tail;
}

export function isValidObjectIdLike(id: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(id);
}
