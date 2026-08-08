"use strict";

const CRED_KEY = "nf.credential";
const DEFAULT_LOW = 70;
const DEFAULT_HIGH = 180;

const state = {
  sgvs: [],
  mbgs: [],
  treatments: [],
  devicestatus: [],
  profiles: [],
  rangeHours: 3,
  auth: { read: false, write: false, write_treatment: false },
};

// ---------- crypto / auth ----------

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

// Sends both a hashed-secret and a raw-token candidate so either a master
// API_SECRET or a subject access token typed into the same box resolves —
// mirrors what the vendored client does across two different code paths.
async function apiFetch(path, options = {}) {
  const cred = getCredential();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  let url = path;
  if (cred) {
    headers["api-secret"] = await sha1Hex(cred);
    url += (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(cred);
  }
  const res = await fetch(url, { ...options, headers });
  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new Error((body && body.message) || res.statusText);
  return body;
}

// ---------- realtime (talks directly to RealtimeHub's envelope protocol) ----------

let ws = null;
let ackSeq = 1;
const pendingAcks = new Map();

function wsSend(event, data, ack) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const msg = { t: "event", ns: "", event, data };
  if (ack) {
    const id = ackSeq++;
    pendingAcks.set(id, ack);
    msg.ackId = id;
  }
  ws.send(JSON.stringify(msg));
}

function setConnLabel(label, live) {
  document.getElementById("conn-label").textContent = label;
  document.getElementById("conn-status").classList.toggle("live", !!live);
}

async function connectRealtime() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/rt`);

  ws.addEventListener("open", async () => {
    const cred = getCredential();
    const secret = cred ? await sha1Hex(cred) : undefined;
    wsSend("authorize", { client: "web", secret, token: cred || undefined, history: 48 }, (auth) => {
      state.auth = auth || { read: false, write: false, write_treatment: false };
      updateAuthButton();
    });
  });

  ws.addEventListener("close", () => {
    setConnLabel("Reconnecting…", false);
    setTimeout(connectRealtime, 2000);
  });

  ws.addEventListener("message", (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    if (msg.t === "ack") {
      const cb = pendingAcks.get(msg.ackId);
      if (cb) {
        pendingAcks.delete(msg.ackId);
        cb(msg.data);
      }
      return;
    }
    if (msg.t !== "event") return;
    if (msg.event === "connected") setConnLabel("Live", true);
    if (msg.event === "dataUpdate") applyDataUpdate(msg.data);
  });
}

// ---------- data merging (mirrors receiveddata.js's mills-based merge) ----------

function mergeByMills(existing, incoming, isDelta) {
  if (!incoming) return existing;
  if (!isDelta) return incoming;
  const known = new Set(existing.map((e) => e.mills));
  const merged = existing.slice();
  for (const item of incoming) {
    if (!known.has(item.mills)) merged.push(item);
  }
  return merged.sort((a, b) => a.mills - b.mills);
}

function mergeTreatments(existing, incoming, isDelta) {
  if (!incoming) return existing;
  if (!isDelta) return incoming;
  let merged = existing.slice();
  for (const item of incoming) {
    const idx = merged.findIndex((e) => e._id === item._id);
    if (item.action === "remove") {
      if (idx >= 0) merged.splice(idx, 1);
      continue;
    }
    const clean = { ...item };
    delete clean.action;
    if (idx >= 0) merged.splice(idx, 1, clean);
    else merged.push(clean);
  }
  return merged.sort((a, b) => a.mills - b.mills);
}

function applyDataUpdate(payload) {
  const isDelta = !!payload.delta;
  state.sgvs = mergeByMills(state.sgvs, payload.sgvs, isDelta);
  state.mbgs = mergeByMills(state.mbgs, payload.mbgs, isDelta);
  state.treatments = mergeTreatments(state.treatments, payload.treatments, isDelta);
  state.devicestatus = mergeByMills(state.devicestatus, payload.devicestatus, isDelta);
  if (payload.profiles) state.profiles = payload.profiles;

  renderReading();
  renderGraph();
  renderInstruments();
  renderTimeline();
}

// ---------- rendering: reading + arrow ----------

const ARROW_ROTATION = {
  DoubleUp: -90,
  SingleUp: -90,
  FortyFiveUp: -45,
  Flat: 0,
  FortyFiveDown: 45,
  SingleDown: 90,
  DoubleDown: 90,
  NONE: null,
  "NOT COMPUTABLE": null,
  RATE_OUT_OF_RANGE: null,
};

function activeTargets() {
  const profile = state.profiles[state.profiles.length - 1];
  const store = profile && profile.store && profile.store[profile.defaultProfile];
  const low = store?.target_low?.[0]?.value;
  const high = store?.target_high?.[0]?.value;
  return { low: Number.isFinite(low) ? low : DEFAULT_LOW, high: Number.isFinite(high) ? high : DEFAULT_HIGH };
}

function zoneFor(mgdl) {
  const { low, high } = activeTargets();
  if (mgdl < low) return "low";
  if (mgdl > high) return "high";
  return "in";
}

function formatAge(mills) {
  const minutes = Math.round((Date.now() - mills) / 60000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function renderReading() {
  const valueEl = document.getElementById("bg-value");
  const arrowEl = document.getElementById("bg-arrow");
  const deltaEl = document.getElementById("bg-delta");
  const readingEl = document.getElementById("reading");

  const latest = state.sgvs[state.sgvs.length - 1];
  if (!latest) {
    valueEl.textContent = "–";
    valueEl.className = "reading-value";
    deltaEl.textContent = "no data yet";
    readingEl.classList.remove("fresh");
    return;
  }

  const zone = zoneFor(latest.mgdl);
  valueEl.textContent = Math.round(latest.mgdl);
  valueEl.className = `reading-value zone-${zone}`;

  const rotation = ARROW_ROTATION[latest.direction];
  arrowEl.innerHTML =
    rotation === null
      ? ""
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(${rotation}deg)"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

  const previous = state.sgvs[state.sgvs.length - 2];
  let deltaText = "";
  if (previous) {
    const delta = Math.round(latest.mgdl - previous.mgdl);
    const cls = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "";
    deltaText = `<span class="${cls}">${delta > 0 ? "+" : ""}${delta}</span>`;
  }
  deltaEl.innerHTML = `${deltaText}${deltaText ? " &middot; " : ""}${formatAge(latest.mills)}`;

  const isFresh = Date.now() - latest.mills < 10 * 60 * 1000;
  readingEl.classList.toggle("fresh", isFresh);
}

// ---------- rendering: graph ----------

function renderGraph() {
  const svg = document.getElementById("bg-graph");
  const cutoff = Date.now() - state.rangeHours * 60 * 60 * 1000;
  const points = state.sgvs.filter((p) => p.mills >= cutoff);

  if (points.length < 2) {
    svg.innerHTML = `<foreignObject x="0" y="0" width="600" height="220"><div xmlns="http://www.w3.org/1999/xhtml" class="graph-empty">Not enough data yet for this range</div></foreignObject>`;
    return;
  }

  const { low, high } = activeTargets();
  const W = 600;
  const H = 220;
  const padTop = 14;
  const padBottom = 24;
  const minMills = points[0].mills;
  const maxMills = points[points.length - 1].mills;
  const span = Math.max(maxMills - minMills, 1);
  const maxVal = Math.max(high + 40, ...points.map((p) => p.mgdl));
  const minVal = Math.min(40, ...points.map((p) => p.mgdl));
  const valSpan = maxVal - minVal;

  const x = (mills) => ((mills - minMills) / span) * W;
  const y = (val) => padTop + (H - padTop - padBottom) * (1 - (val - minVal) / valSpan);

  // Light smoothing via quadratic midpoints, rather than a raw scatter/polyline.
  let linePath = `M ${x(points[0].mills).toFixed(1)} ${y(points[0].mgdl).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const mx = (x(p0.mills) + x(p1.mills)) / 2;
    const my = (y(p0.mgdl) + y(p1.mgdl)) / 2;
    linePath += ` Q ${x(p0.mills).toFixed(1)} ${y(p0.mgdl).toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  linePath += ` T ${x(points[points.length - 1].mills).toFixed(1)} ${y(points[points.length - 1].mgdl).toFixed(1)}`;

  const areaPath = `${linePath} L ${W} ${H - padBottom} L 0 ${H - padBottom} Z`;
  const bandTop = y(high);
  const bandBottom = y(low);

  const ticks = [];
  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const mills = minMills + (span * i) / tickCount;
    const label = new Date(mills).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    ticks.push(`<text x="${x(mills).toFixed(1)}" y="${H - 6}" font-size="10" fill="var(--text-faint)" text-anchor="middle">${label}</text>`);
  }

  svg.innerHTML = `
    <defs>
      <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--zone-in)" stop-opacity="0.28" />
        <stop offset="100%" stop-color="var(--zone-in)" stop-opacity="0" />
      </linearGradient>
    </defs>
    <rect x="0" y="${bandTop.toFixed(1)}" width="${W}" height="${(bandBottom - bandTop).toFixed(1)}" fill="var(--zone-in-soft)" />
    <path d="${areaPath}" fill="url(#areaFill)" />
    <path d="${linePath}" fill="none" stroke="var(--zone-in)" stroke-width="2" stroke-linecap="round" />
    ${points
      .map((p) => {
        const zone = zoneFor(p.mgdl);
        const color = zone === "in" ? "var(--zone-in)" : zone === "high" ? "var(--zone-high)" : "var(--zone-low)";
        return `<circle cx="${x(p.mills).toFixed(1)}" cy="${y(p.mgdl).toFixed(1)}" r="2.2" fill="${color}" />`;
      })
      .join("")}
    ${ticks.join("")}
  `;
}

// ---------- rendering: instrument pills (honest, simple aggregates — no fabricated IOB/COB) ----------

function renderInstruments() {
  const row = document.getElementById("instrument-row");
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const todays = state.treatments.filter((t) => t.mills >= dayAgo);
  const carbsToday = todays.reduce((sum, t) => sum + (Number(t.carbs) || 0), 0);
  const insulinToday = todays.reduce((sum, t) => sum + (Number(t.insulin) || 0), 0);
  const lastTreatment = state.treatments[state.treatments.length - 1];
  const profile = state.profiles[state.profiles.length - 1];

  const items = [
    { label: "Carbs (24h)", value: carbsToday ? `${carbsToday}<span class="unit">g</span>` : "–" },
    { label: "Insulin (24h)", value: insulinToday ? `${insulinToday.toFixed(1)}<span class="unit">u</span>` : "–" },
    { label: "Last entry", value: lastTreatment ? formatAge(lastTreatment.mills) : "–" },
    { label: "Active profile", value: profile ? profile.defaultProfile || "Default" : "–" },
  ];

  row.innerHTML = items
    .map((it) => `<div class="card instrument"><span class="label">${it.label}</span><span class="value">${it.value}</span></div>`)
    .join("");
}

// ---------- rendering: timeline ----------

const EVENT_ICONS = {
  "Meal Bolus": "M12 2v20M2 12h20",
  "Correction Bolus": "M12 2v20M2 12h20",
  "Snack Bolus": "M12 2v20M2 12h20",
  "Carb Correction": "M4 12h16",
  "BG Check": "M12 8v4l3 3",
  Exercise: "M6 3v18M18 3v18M2 12h20",
  Note: "M4 4h16v16H4z",
};
const DEFAULT_ICON = "M12 8v4l3 3M12 22a10 10 0 100-20 10 10 0 000 20z";

function renderTimeline() {
  const list = document.getElementById("timeline");
  const items = state.treatments.slice().sort((a, b) => b.mills - a.mills).slice(0, 20);

  if (items.length === 0) {
    list.innerHTML = `<li class="timeline-empty">Nothing logged yet — use the + button to add a treatment.</li>`;
    return;
  }

  list.innerHTML = items
    .map((t) => {
      const icon = EVENT_ICONS[t.eventType] || DEFAULT_ICON;
      const details = [
        t.carbs ? `${t.carbs}g carbs` : "",
        t.insulin ? `${t.insulin}u insulin` : "",
        t.glucose ? `${t.glucose} ${t.glucoseType || ""}`.trim() : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `
        <li class="timeline-item">
          <span class="timeline-node"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${icon}"/></svg></span>
          <div class="timeline-time">${formatAge(t.mills)}</div>
          <div class="timeline-title">${t.eventType || "Treatment"}</div>
          ${details ? `<div class="timeline-detail">${details}</div>` : ""}
          ${t.notes ? `<div class="timeline-detail">${escapeHtml(t.notes)}</div>` : ""}
        </li>`;
    })
    .join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- auth modal ----------

function openModal(id) {
  document.getElementById(id).classList.add("open");
}
function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}

function updateAuthButton() {
  const btn = document.getElementById("auth-btn");
  btn.classList.toggle("authed", !!(state.auth.read && getCredential()));
}

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});
document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal(backdrop.id);
  });
});

document.getElementById("auth-btn").addEventListener("click", () => {
  document.getElementById("auth-input").value = getCredential();
  document.getElementById("auth-status").textContent = "";
  openModal("auth-backdrop");
});

document.getElementById("auth-submit").addEventListener("click", async () => {
  const value = document.getElementById("auth-input").value.trim();
  const status = document.getElementById("auth-status");
  status.textContent = "Checking…";

  // verifyauth distinguishes "a real credential matched" from "anonymous
  // default read access" (both of which report read:true over the
  // realtime socket) — exactly the signal we need here.
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
  if (ws) ws.close();
  connectRealtime();
  closeModal("auth-backdrop");
});

// ---------- treatment modal ----------

document.getElementById("add-treatment-fab").addEventListener("click", () => {
  if (!getCredential()) {
    document.getElementById("auth-btn").click();
    return;
  }
  document.getElementById("treatment-form").reset();
  document.getElementById("treatment-status").textContent = "";
  openModal("treatment-backdrop");
});

document.getElementById("treatment-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const payload = {
    eventType: form.get("eventType"),
    created_at: new Date().toISOString(),
    notes: form.get("notes") || undefined,
    carbs: form.get("carbs") ? Number(form.get("carbs")) : undefined,
    insulin: form.get("insulin") ? Number(form.get("insulin")) : undefined,
    enteredBy: "nightflare-new-ui",
  };
  const status = document.getElementById("treatment-status");
  status.textContent = "Saving…";
  try {
    await apiFetch("/api/v1/treatments", { method: "POST", body: JSON.stringify(payload) });
    status.textContent = "Saved.";
    setTimeout(() => closeModal("treatment-backdrop"), 400);
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  }
});

// ---------- range selector ----------

document.getElementById("range-select").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-hours]");
  if (!btn) return;
  document.querySelectorAll("#range-select button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.rangeHours = Number(btn.dataset.hours);
  renderGraph();
});

// ---------- boot ----------

fetch("/api/v1/status.json")
  .then((r) => r.json())
  .then((s) => {
    if (s.settings?.customTitle) document.getElementById("site-title").textContent = s.settings.customTitle;
    if (s.settings?.units === "mmol") document.getElementById("bg-units").textContent = "mmol/L";
  })
  .catch(() => {});

updateAuthButton();
connectRealtime();
