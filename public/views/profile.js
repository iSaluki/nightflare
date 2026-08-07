import { api } from "/lib/api.js";

const TEMPLATE = {
  defaultProfile: "Default",
  startDate: new Date().toISOString(),
  units: "mg/dl",
  store: {
    Default: {
      dia: 4,
      timezone: "UTC",
      units: "mg/dl",
      carbratio: [{ time: "00:00", value: 10, timeAsSeconds: 0 }],
      sens: [{ time: "00:00", value: 50, timeAsSeconds: 0 }],
      basal: [{ time: "00:00", value: 1, timeAsSeconds: 0 }],
      target_low: [{ time: "00:00", value: 80, timeAsSeconds: 0 }],
      target_high: [{ time: "00:00", value: 180, timeAsSeconds: 0 }],
    },
  },
};

export async function renderProfile(container) {
  container.innerHTML = `
    <div class="card">
      <div class="section-title">Profile</div>
      <p class="muted">
        Full profile document as JSON — matches Nightscout's profile schema (per-time-of-day
        basal rates, carb ratios, sensitivity, and target range under <code>store.&lt;name&gt;</code>).
        Saving creates a new versioned profile entry, same as a Nightscout "profile switch".
      </p>
      <form id="profile-form" class="stack">
        <textarea name="profile" rows="20" style="font-family: monospace"></textarea>
        <button class="primary" type="submit">Save as new profile version</button>
      </form>
      <div id="profile-status" class="muted" style="margin-top:8px"></div>
    </div>
  `;

  const textarea = container.querySelector("textarea[name=profile]");
  const status = container.querySelector("#profile-status");
  const form = container.querySelector("#profile-form");

  try {
    const current = await api("/api/v1/profile/current");
    textarea.value = JSON.stringify(current, null, 2);
  } catch {
    textarea.value = JSON.stringify(TEMPLATE, null, 2);
    status.textContent = "No profile set yet — edit the template below and save.";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let payload;
    try {
      payload = JSON.parse(textarea.value);
    } catch (err) {
      status.textContent = `Invalid JSON: ${err.message}`;
      return;
    }
    delete payload._id;
    payload.startDate = new Date().toISOString();
    status.textContent = "Saving…";
    try {
      await api("/api/v1/profile", { method: "POST", body: JSON.stringify(payload) });
      status.textContent = "Saved.";
    } catch (err) {
      status.textContent = `Failed: ${err.message}`;
    }
  });
}
