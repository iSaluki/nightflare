"use strict";

// Shared helpers for every new-ui page except dashboard.html (which predates
// this file and stays self-contained). Each page includes this before its
// own <page>.js and provides the standard topbar markup (#site-title,
// #auth-btn, #auth-backdrop with #auth-input/#auth-status/#auth-submit) for
// wireTopbar() to hook up.

const CRED_KEY = "nf.credential";

async function sha1Hex(input) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function getCredential() {
  return localStorage.getItem(CRED_KEY) || "";
}
function setCredential(value) {
  if (value) localStorage.setItem(CRED_KEY, value);
  else localStorage.removeItem(CRED_KEY);
}

async function withAuthHeaders(headers) {
  const cred = getCredential();
  if (!cred) return { headers, query: "" };
  return {
    headers: { ...headers, "api-secret": await sha1Hex(cred) },
    query: "token=" + encodeURIComponent(cred),
  };
}

function appendQuery(path, query) {
  if (!query) return path;
  return path + (path.includes("?") ? "&" : "?") + query;
}

async function handleResponse(res) {
  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new Error((body && body.message) || res.statusText || `HTTP ${res.status}`);
  return body;
}

/** JSON request/response — used by endpoints backed by collectionRoute
 * (entries, treatments, profile, food, ...), which accept a JSON body. */
async function apiFetch(path, options = {}) {
  const { headers, query } = await withAuthHeaders({ "Content-Type": "application/json", ...(options.headers || {}) });
  const res = await fetch(appendQuery(path, query), { ...options, headers });
  return handleResponse(res);
}

/** Form-encoded request — used by /api/v2/authorization/{subjects,roles},
 * which parse bodies with Hono's parseBody (form/multipart), not JSON. */
async function apiFetchForm(path, params, method = "POST") {
  const { headers, query } = await withAuthHeaders({ "Content-Type": "application/x-www-form-urlencoded" });
  const res = await fetch(appendQuery(path, query), { method, headers, body: params.toString() });
  return handleResponse(res);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function openModal(id) {
  document.getElementById(id).classList.add("open");
}
function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });
});

/** Wires the shared topbar: site title from /api/v1/status, and the
 * auth modal (api-secret or subject token, verified via /api/v1/verifyauth
 * exactly like dashboard.html does). Dispatches "nf-auth-changed" on the
 * window once a credential is accepted so pages can reload gated data. */
function wireTopbar() {
  fetch("/api/v1/status.json")
    .then((r) => r.json())
    .then((s) => {
      const el = document.getElementById("site-title");
      if (el && s.settings?.customTitle) el.textContent = s.settings.customTitle;
    })
    .catch(() => {});

  const authBtn = document.getElementById("auth-btn");
  if (!authBtn) return;

  const updateAuthButton = () => authBtn.classList.toggle("authed", !!getCredential());

  authBtn.addEventListener("click", () => {
    document.getElementById("auth-input").value = getCredential();
    document.getElementById("auth-status").textContent = "";
    openModal("auth-backdrop");
  });

  document.getElementById("auth-submit").addEventListener("click", async () => {
    const value = document.getElementById("auth-input").value.trim();
    const status = document.getElementById("auth-status");
    status.textContent = "Checking…";

    const previous = getCredential();
    setCredential(value);
    let verified = false;
    try {
      const result = await apiFetch("/api/v1/verifyauth");
      verified = result?.message?.message === "OK";
    } catch {
      verified = false;
    }

    if (!verified && value) {
      setCredential(previous);
      status.textContent = "Couldn't verify that secret or token.";
      return;
    }

    status.textContent = "";
    closeModal("auth-backdrop");
    updateAuthButton();
    window.dispatchEvent(new CustomEvent("nf-auth-changed"));
  });

  updateAuthButton();
}
