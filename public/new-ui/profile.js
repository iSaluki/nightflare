"use strict";

let profileId = null;
let startDate = null;

const schedules = {
  basal: [{ time: "00:00", value: 1 }],
  carbratio: [{ time: "00:00", value: 10 }],
  sens: [{ time: "00:00", value: 50 }],
  target: [{ time: "00:00", low: 70, high: 180 }],
};

function timeToSeconds(time) {
  const [h, m] = time.split(":").map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
}

function sortByTime(rows) {
  return rows.slice().sort((a, b) => timeToSeconds(a.time) - timeToSeconds(b.time));
}

function renderSchedule(kind) {
  const container = document.getElementById(`${kind}-editor`);
  const rows = schedules[kind];
  const isTarget = kind === "target";

  container.innerHTML = rows
    .map(
      (row, i) => `
      <div class="schedule-row ${isTarget ? "target" : ""}" data-index="${i}">
        <input type="time" value="${row.time}" data-field="time" />
        ${
          isTarget
            ? `<input type="number" step="1" value="${row.low}" data-field="low" placeholder="Low" />
               <input type="number" step="1" value="${row.high}" data-field="high" placeholder="High" />`
            : `<input type="number" step="0.05" value="${row.value}" data-field="value" />
               <span></span>`
        }
        <button type="button" class="icon-only danger" data-remove title="Remove">✕</button>
      </div>`
    )
    .join("");
}

function renderAllSchedules() {
  ["basal", "carbratio", "sens", "target"].forEach(renderSchedule);
}

document.querySelectorAll(".schedule-editor").forEach((editor) => {
  editor.addEventListener("input", (e) => {
    const row = e.target.closest(".schedule-row");
    if (!row) return;
    const kind = editor.id.replace("-editor", "");
    const index = Number(row.dataset.index);
    const field = e.target.dataset.field;
    const value = field === "time" ? e.target.value : Number(e.target.value);
    schedules[kind][index][field] = value;
  });
  editor.addEventListener("click", (e) => {
    if (!e.target.closest("[data-remove]")) return;
    const row = e.target.closest(".schedule-row");
    const kind = editor.id.replace("-editor", "");
    const index = Number(row.dataset.index);
    if (schedules[kind].length <= 1) return;
    schedules[kind].splice(index, 1);
    renderSchedule(kind);
  });
});

document.querySelectorAll("[data-add]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.add;
    const last = schedules[kind][schedules[kind].length - 1];
    const next = kind === "target" ? { time: "12:00", low: last.low, high: last.high } : { time: "12:00", value: last.value };
    schedules[kind].push(next);
    renderSchedule(kind);
  });
});

function notice(message, isError) {
  const el = document.getElementById("profile-notice");
  el.textContent = message;
  el.classList.toggle("error", !!isError);
  el.style.display = message ? "" : "none";
}

function toScheduleField(rows) {
  return sortByTime(rows).map((r) => ({ time: r.time, value: r.value, timeAsSeconds: timeToSeconds(r.time) }));
}

async function loadProfile() {
  try {
    const doc = await apiFetch("/api/v1/profile/current");
    profileId = doc._id;
    startDate = doc.startDate || null;
    const name = doc.defaultProfile || Object.keys(doc.store || {})[0] || "Default";
    const store = (doc.store && doc.store[name]) || {};

    document.getElementById("p-name").value = name;
    document.getElementById("p-units").value = doc.units || store.units || "mg/dl";
    document.getElementById("p-dia").value = store.dia ?? 3;
    document.getElementById("p-timezone").value = store.timezone || "";

    if (Array.isArray(store.basal) && store.basal.length) schedules.basal = store.basal.map((r) => ({ time: r.time, value: r.value }));
    if (Array.isArray(store.carbratio) && store.carbratio.length) schedules.carbratio = store.carbratio.map((r) => ({ time: r.time, value: r.value }));
    if (Array.isArray(store.sens) && store.sens.length) schedules.sens = store.sens.map((r) => ({ time: r.time, value: r.value }));
    if (Array.isArray(store.target_low) && store.target_low.length) {
      schedules.target = store.target_low.map((low, i) => ({
        time: low.time,
        low: low.value,
        high: (store.target_high && store.target_high[i] && store.target_high[i].value) ?? low.value,
      }));
    }
    renderAllSchedules();
    notice("");
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes("no profile")) {
      notice("No profile set yet — fill in the form below and save to create one.");
      renderAllSchedules();
    } else if (err.message && err.message.toLowerCase().includes("unauthorized")) {
      notice("Sign in to view and edit the profile.");
    } else {
      notice(`Couldn't load profile: ${err.message}`, true);
    }
  }
}

document.getElementById("save-profile-btn").addEventListener("click", async () => {
  const name = document.getElementById("p-name").value.trim() || "Default";
  const units = document.getElementById("p-units").value;
  const dia = Number(document.getElementById("p-dia").value) || 3;
  const timezone = document.getElementById("p-timezone").value.trim();

  const targetSorted = sortByTime(schedules.target);
  const payload = {
    defaultProfile: name,
    startDate: startDate || new Date().toISOString(),
    mills: 0,
    units,
    store: {
      [name]: {
        dia,
        timezone: timezone || undefined,
        units,
        basal: toScheduleField(schedules.basal),
        carbratio: toScheduleField(schedules.carbratio),
        sens: toScheduleField(schedules.sens),
        target_low: targetSorted.map((r) => ({ time: r.time, value: r.low, timeAsSeconds: timeToSeconds(r.time) })),
        target_high: targetSorted.map((r) => ({ time: r.time, value: r.high, timeAsSeconds: timeToSeconds(r.time) })),
        carbs_hr: 20,
        delay: 20,
      },
    },
  };
  if (profileId) payload._id = profileId;

  notice("Saving…");
  try {
    let saved;
    if (profileId) {
      saved = await apiFetch(`/api/v1/profile/${profileId}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      saved = await apiFetch("/api/v1/profile", { method: "POST", body: JSON.stringify(payload) });
    }
    profileId = saved._id;
    notice("Saved.");
  } catch (err) {
    notice(`Failed to save: ${err.message}`, true);
  }
});

window.addEventListener("nf-auth-changed", loadProfile);
renderAllSchedules();
wireTopbar();
loadProfile();
