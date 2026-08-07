async function digestHex(algo: "SHA-1" | "SHA-256", input: string): Promise<string> {
  const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Nightscout clients send `api-secret: sha1(plainSecret)`. */
export function sha1Hex(input: string): Promise<string> {
  return digestHex("SHA-1", input);
}

/** Used for hashing subject access tokens before storing/comparing them. */
export function sha256Hex(input: string): Promise<string> {
  return digestHex("SHA-256", input);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 24): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Used to derive a subject's access token deterministically from its id
 * and the deployment's master secret, mirroring Nightscout's "enclave"
 * subject hash: no raw token is ever stored, and it stays stable across
 * reads (so an admin can copy it again later) but rotates automatically if
 * API_SECRET changes. */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}
