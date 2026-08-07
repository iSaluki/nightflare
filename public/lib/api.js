const STORAGE_KEY = "nightflare.apiSecret";

export function getStoredSecret() {
  return localStorage.getItem(STORAGE_KEY) || "";
}

export function setStoredSecret(secret) {
  if (secret) localStorage.setItem(STORAGE_KEY, secret);
  else localStorage.removeItem(STORAGE_KEY);
}

async function sha1Hex(input) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function authHeaders() {
  const secret = getStoredSecret();
  if (!secret) return {};
  return { "api-secret": await sha1Hex(secret) };
}

export async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()), ...(options.headers || {}) };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 204) return null;
  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const message = (body && body.message) || res.statusText;
    throw new Error(message);
  }
  return body;
}

export async function checkAuth() {
  try {
    const result = await api("/api/v1/verifyauth");
    return result.status === 200;
  } catch {
    return false;
  }
}
