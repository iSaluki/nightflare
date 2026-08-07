function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Minimal HS256 JWT, matching the shape Nightscout's `authorization.authorize()`
 * issues (a signed `{accessToken}` payload with iat/exp) closely enough for
 * the vendored client's `Authorization: Bearer <token>` flow to work. */
export async function signJwt(payload: Record<string, unknown>, secret: string, expiresInSeconds = 60 * 60 * 24 * 30): Promise<{
  token: string;
  iat: number;
  exp: number;
}> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expiresInSeconds;
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat, exp };
  const headerPart = base64url(JSON.stringify(header));
  const payloadPart = base64url(JSON.stringify(body));
  const signingInput = `${headerPart}.${payloadPart}`;
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return { token: `${signingInput}.${base64url(signature)}`, iat, exp };
}

export async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlDecode(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadPart)));
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
