import { api } from "/lib/api.js";

const EVENT_TYPES = [
  "BG Check",
  "Snack Bolus",
  "Meal Bolus",
  "Correction Bolus",
  "Carb Correction",
  "Combo Bolus",
  "Announcement",
  "Note",
  "Exercise",
  "Site Change",
  "Sensor Start",
  "Sensor Change",
  "Insulin Cartridge Change",
  "Temporary Target",
];

export async function renderTreatments(container) {
  container.innerHTML = `
    <div class="card">
      <div class="section-title">Add treatment</div>
      <form id="treatment-form" class="grid">
        <label>Event type
          <select name="eventType">${EVENT_TYPES.map((t) => `<option>${t}</option>`).join("")}</select>
        </label>
        <label>Glucose <input name="glucose" type="number" step="0.1" /></label>
        <label>Carbs (g) <input name="carbs" type="number" step="1" /></label>
        <label>Insulin (u) <input name="insulin" type="number" step="0.05" /></label>
        <label style="grid-column: 1 / -1">Notes <input name="notes" type="text" /></label>
        <button class="primary" type="submit">Save treatment</button>
      </form>
      <div id="treatment-status" class="muted" style="margin-top:8px"></div>
    </div>
    <div class="card">
      <div class="section-title">History</div>
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Glucose</th><th>Carbs</th><th>Insulin</th><th>Notes</th><th></th></tr></thead>
        <tbody id="treatments-body"><tr><td colspan="7" class="muted">Loading…</td></tr></tbody>
      </table>
    </div>
  `;

  const body = container.querySelector("#treatments-body");
  const form = container.querySelector("#treatment-form");
  const status = container.querySelector("#treatment-status");

  async function load() {
    const treatments = await api("/api/v1/treatments?count=50");
    body.innerHTML = treatments.length
      ? treatments
          .map(
            (t) => `
        <tr>
          <td>${t.created_at ? new Date(t.created_at).toLocaleString() : ""}</td>
          <td>${t.eventType ?? ""}</td>
          <td>${t.glucose ?? ""}</td>
          <td>${t.carbs ?? ""}</td>
          <td>${t.insulin ?? ""}</td>
          <td>${t.notes ?? ""}</td>
          <td><button class="ghost" data-delete="${t._id}">Delete</button></td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="7" class="muted">No treatments yet</td></tr>`;

    body.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/v1/treatments/${btn.dataset.delete}`, { method: "DELETE" });
        load();
      });
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const payload = {
      eventType: data.eventType,
      created_at: new Date().toISOString(),
      notes: data.notes || undefined,
      glucose: data.glucose ? Number(data.glucose) : undefined,
      carbs: data.carbs ? Number(data.carbs) : undefined,
      insulin: data.insulin ? Number(data.insulin) : undefined,
      enteredBy: "nightflare-web",
    };
    status.textContent = "Saving…";
    try {
      await api("/api/v1/treatments", { method: "POST", body: JSON.stringify(payload) });
      status.textContent = "Saved.";
      form.reset();
      load();
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
    }
  });

  await load();
}
