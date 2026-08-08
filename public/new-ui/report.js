"use strict";

const PAGE_SIZE = 1000;
const MAX_PAGES = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

let targets = { low: 70, high: 180 };
let displayUnit = "mg/dl";
let rangeDays = 7;

function toDisplay(mgdl) {
  if (displayUnit === "mmol") return (mgdl / 18.0182).toFixed(1);
  return String(Math.round(mgdl));
}

function treatmentMillis(t) {
  for (const field of ["created_at", "date", "timestamp"]) {
    const v = t[field];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const parsed = Date.parse(v);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

/** Pages backward from `toMs` down to `fromMs` using the date cursor, since
 * the collection API caps any single request at 1000 rows regardless of the
 * requested `count` — same pattern as the import job's alarm loop. */
async function fetchPaged(path, fromMs, toMs, extraParams) {
  const out = [];
  let cursor = toMs;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams(extraParams || {});
    params.set("count", String(PAGE_SIZE));
    params.set("find[date][$gte]", String(fromMs));
    params.set("find[date][$lt]", String(cursor));
    const batch = await apiFetch(`${path}?${params.toString()}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    const dates = batch.map((d) => Number(d.date)).filter((n) => Number.isFinite(n));
    if (!dates.length) break;
    cursor = Math.min(...dates);
  }
  return out;
}

async function loadTargets() {
  try {
    const doc = await apiFetch("/api/v1/profile/current");
    const name = doc.defaultProfile || Object.keys(doc.store || {})[0];
    const store = name && doc.store ? doc.store[name] : null;
    const low = store?.target_low?.[0]?.value;
    const high = store?.target_high?.[0]?.value;
    if (Number.isFinite(low)) targets.low = low;
    if (Number.isFinite(high)) targets.high = high;
  } catch {
    // keep defaults
  }
}

function localDayKey(mills) {
  const d = new Date(mills);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function mean(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stdDev(nums, avg) {
  if (nums.length < 2) return 0;
  const variance = nums.reduce((sum, n) => sum + (n - avg) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(variance);
}

function renderStats(sgvs) {
  const grid = document.getElementById("report-stats");
  if (sgvs.length === 0) {
    grid.innerHTML = `<div class="empty-state">No glucose readings in this range.</div>`;
    document.getElementById("tir-bar").innerHTML = "";
    return;
  }
  const avg = mean(sgvs);
  const sd = stdDev(sgvs, avg);
  const cv = (sd / avg) * 100;
  const gmi = 3.31 + 0.02392 * avg;

  const items = [
    { label: "Average", value: `${toDisplay(avg)}<span class="unit">${displayUnit}</span>` },
    { label: "Est. A1C (GMI)", value: `${gmi.toFixed(1)}<span class="unit">%</span>` },
    { label: "Std deviation", value: toDisplay(sd) },
    { label: "CV", value: `${cv.toFixed(0)}<span class="unit">%</span>` },
    { label: "Readings", value: String(sgvs.length) },
  ];
  grid.innerHTML = items
    .map((it) => `<div class="card instrument"><span class="label">${it.label}</span><span class="value">${it.value}</span></div>`)
    .join("");

  const low = sgvs.filter((v) => v < targets.low).length;
  const high = sgvs.filter((v) => v > targets.high).length;
  const inRange = sgvs.length - low - high;
  const pct = (n) => (n / sgvs.length) * 100;

  const bar = document.getElementById("tir-bar");
  bar.innerHTML = [
    low > 0 ? `<span class="tir-low" style="width:${pct(low)}%" title="Low: ${pct(low).toFixed(0)}%">${pct(low) > 8 ? pct(low).toFixed(0) + "%" : ""}</span>` : "",
    `<span class="tir-in" style="width:${pct(inRange)}%" title="In range: ${pct(inRange).toFixed(0)}%">${pct(inRange).toFixed(0)}%</span>`,
    high > 0 ? `<span class="tir-high" style="width:${pct(high)}%" title="High: ${pct(high).toFixed(0)}%">${pct(high) > 8 ? pct(high).toFixed(0) + "%" : ""}</span>` : "",
  ].join("");
}

function renderDailyGraph(days) {
  const svg = document.getElementById("daily-graph");
  const points = days.filter((d) => d.count > 0);
  if (points.length < 2) {
    svg.innerHTML = `<foreignObject x="0" y="0" width="600" height="200"><div xmlns="http://www.w3.org/1999/xhtml" class="graph-empty">Not enough data for a trend line</div></foreignObject>`;
    return;
  }
  const W = 600;
  const H = 200;
  const padTop = 14;
  const padBottom = 24;
  const maxVal = Math.max(targets.high + 40, ...points.map((p) => p.max));
  const minVal = Math.min(40, ...points.map((p) => p.min));
  const valSpan = maxVal - minVal || 1;
  const x = (i) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (val) => padTop + (H - padTop - padBottom) * (1 - (val - minVal) / valSpan);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.avg).toFixed(1)}`).join(" ");
  const bandTop = y(targets.high);
  const bandBottom = y(targets.low);

  svg.innerHTML = `
    <rect x="0" y="${bandTop.toFixed(1)}" width="${W}" height="${(bandBottom - bandTop).toFixed(1)}" fill="var(--zone-in-soft)" />
    <path d="${linePath}" fill="none" stroke="var(--zone-in)" stroke-width="2" stroke-linecap="round" />
    ${points
      .map((p, i) => {
        const zone = p.avg < targets.low ? "var(--zone-low)" : p.avg > targets.high ? "var(--zone-high)" : "var(--zone-in)";
        return `<circle cx="${x(i).toFixed(1)}" cy="${y(p.avg).toFixed(1)}" r="3" fill="${zone}" />`;
      })
      .join("")}
    ${points
      .map((p, i) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" font-size="10" fill="var(--text-faint)" text-anchor="middle">${p.label}</text>`)
      .join("")}
  `;
}

function renderDailyTable(days) {
  const body = document.getElementById("daily-body");
  const rows = days.slice().reverse();
  if (!rows.some((d) => d.count > 0 || d.carbs || d.insulin)) {
    body.innerHTML = `<tr><td colspan="8" class="empty-state">No data in this range.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map((d) => {
      if (d.count === 0) {
        return `<tr>
          <td>${d.label}</td>
          <td colspan="4" class="empty-state">No readings</td>
          <td>0</td>
          <td>${d.carbs ? d.carbs + "g" : "–"}</td>
          <td>${d.insulin ? d.insulin.toFixed(1) + "u" : "–"}</td>
        </tr>`;
      }
      const inRangePct = ((d.count - d.low - d.high) / d.count) * 100;
      return `<tr>
        <td>${d.label}</td>
        <td>${toDisplay(d.avg)}</td>
        <td>${toDisplay(d.min)}</td>
        <td>${toDisplay(d.max)}</td>
        <td>${inRangePct.toFixed(0)}%</td>
        <td>${d.count}</td>
        <td>${d.carbs ? d.carbs + "g" : "–"}</td>
        <td>${d.insulin ? d.insulin.toFixed(1) + "u" : "–"}</td>
      </tr>`;
    })
    .join("");
}

async function generateReport() {
  const status = document.getElementById("report-status");
  const results = document.getElementById("report-results");
  const tableCard = document.getElementById("report-table-card");
  status.textContent = "Loading…";
  results.style.display = "none";
  tableCard.style.display = "none";

  const toMs = Date.now();
  const fromMs = toMs - rangeDays * DAY_MS;

  try {
    const [status_, entries, treatments] = await Promise.all([
      apiFetch("/api/v1/status.json").catch(() => null),
      fetchPaged("/api/v1/entries/sgv", fromMs, toMs),
      fetchPaged("/api/v1/treatments", fromMs, toMs),
    ]);
    if (status_?.settings?.units === "mmol") displayUnit = "mmol";

    const sgvs = entries.map((e) => Number(e.sgv)).filter((v) => Number.isFinite(v) && v > 0);

    const dayBuckets = new Map();
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = new Date(toMs - i * DAY_MS);
      const key = localDayKey(d.getTime());
      dayBuckets.set(key, { label: d.toLocaleDateString([], { month: "short", day: "numeric" }), values: [], carbs: 0, insulin: 0 });
    }
    for (const e of entries) {
      const v = Number(e.sgv);
      if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(Number(e.date))) continue;
      const bucket = dayBuckets.get(localDayKey(Number(e.date)));
      if (bucket) bucket.values.push(v);
    }
    for (const t of treatments) {
      const mills = treatmentMillis(t);
      if (mills === null) continue;
      const bucket = dayBuckets.get(localDayKey(mills));
      if (!bucket) continue;
      if (Number.isFinite(Number(t.carbs))) bucket.carbs += Number(t.carbs);
      if (Number.isFinite(Number(t.insulin))) bucket.insulin += Number(t.insulin);
    }

    const days = Array.from(dayBuckets.values()).map((b) => {
      const count = b.values.length;
      const low = b.values.filter((v) => v < targets.low).length;
      const high = b.values.filter((v) => v > targets.high).length;
      return {
        label: b.label,
        count,
        avg: count ? mean(b.values) : 0,
        min: count ? Math.min(...b.values) : 0,
        max: count ? Math.max(...b.values) : 0,
        low,
        high,
        carbs: Math.round(b.carbs),
        insulin: b.insulin,
      };
    });

    renderStats(sgvs);
    renderDailyGraph(days);
    renderDailyTable(days);
    results.style.display = "";
    tableCard.style.display = "";
    status.textContent = entries.length >= PAGE_SIZE * MAX_PAGES ? "Loaded (range may be truncated — a lot of data in this window)." : "";
  } catch (err) {
    status.textContent = `Failed to load report: ${err.message}`;
  }
}

document.getElementById("range-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-days]");
  if (!btn) return;
  document.querySelectorAll("#range-tabs button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  rangeDays = Number(btn.dataset.days);
  generateReport();
});

window.addEventListener("nf-auth-changed", generateReport);
wireTopbar();
loadTargets().then(generateReport);
