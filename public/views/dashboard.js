import { api } from "/lib/api.js";
import { drawGraph } from "/lib/graph.js";

const ARROWS = {
  DoubleUp: "⇈",
  SingleUp: "↑",
  FortyFiveUp: "↗",
  Flat: "→",
  FortyFiveDown: "↘",
  SingleDown: "↓",
  DoubleDown: "⇊",
  NONE: "",
  "NOT COMPUTABLE": "?",
  RATE_OUT_OF_RANGE: "⚠",
};

function formatAge(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  return `${minutes} min ago`;
}

function rangeClass(sgv) {
  if (sgv < 70) return "low";
  if (sgv > 180) return "high";
  return "in-range";
}

export async function renderDashboard(container) {
  container.innerHTML = `
    <div class="card">
      <div id="bg-hero" class="bg-hero"><span class="value">--</span></div>
      <div id="bg-stale" class="bg-stale"></div>
    </div>
    <div class="card">
      <div class="section-title">Last 3 hours</div>
      <canvas id="bg-graph"></canvas>
    </div>
    <div class="card">
      <div class="section-title">Recent treatments</div>
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Details</th><th>Notes</th></tr></thead>
        <tbody id="recent-treatments"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
      </table>
    </div>
  `;

  const hero = container.querySelector("#bg-hero");
  const stale = container.querySelector("#bg-stale");
  const canvas = container.querySelector("#bg-graph");
  const treatmentsBody = container.querySelector("#recent-treatments");

  async function loadEntries() {
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const entries = await api(`/api/v1/entries/sgv?count=200&find[date][$gte]=${threeHoursAgo}`);
    drawGraph(canvas, entries);

    if (entries.length > 0) {
      const [latest, previous] = entries;
      hero.className = `bg-hero ${rangeClass(latest.sgv)}`;
      const delta = previous ? latest.sgv - previous.sgv : null;
      hero.innerHTML = `
        <span class="value">${latest.sgv}</span>
        <span class="arrow">${ARROWS[latest.direction] ?? ""}</span>
        ${delta !== null ? `<span class="delta">${delta > 0 ? "+" : ""}${delta}</span>` : ""}
      `;
      stale.textContent = `Updated ${formatAge(latest.date)}`;
    }
  }

  async function loadTreatments() {
    const treatments = await api("/api/v1/treatments?count=15");
    treatmentsBody.innerHTML = treatments.length
      ? treatments
          .map((t) => {
            const time = t.created_at ? new Date(t.created_at).toLocaleString() : "";
            const details = [
              t.glucose ? `${t.glucose} ${t.glucoseType ?? ""}` : "",
              t.carbs ? `${t.carbs}g carbs` : "",
              t.insulin ? `${t.insulin}u insulin` : "",
            ]
              .filter(Boolean)
              .join(", ");
            return `<tr><td>${time}</td><td>${t.eventType ?? ""}</td><td>${details}</td><td>${t.notes ?? ""}</td></tr>`;
          })
          .join("")
      : `<tr><td colspan="4" class="muted">No treatments yet</td></tr>`;
  }

  await Promise.all([loadEntries(), loadTreatments()]);

  const refresh = () => Promise.all([loadEntries(), loadTreatments()]).catch(() => {});
  const pollId = setInterval(refresh, 60000);

  let ws;
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/rt`);
    ws.addEventListener("message", refresh);
  } catch {
    // WebSocket unavailable; polling still covers us.
  }

  return () => {
    clearInterval(pollId);
    if (ws) ws.close();
  };
}
