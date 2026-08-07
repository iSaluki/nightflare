import { api } from "/lib/api.js";

const COLLECTIONS = ["entries", "treatments", "devicestatus", "profile", "food", "activity"];

export async function renderAdmin(container) {
  container.innerHTML = `
    <div class="card">
      <div class="section-title">Import from another Nightscout instance</div>
      <p class="muted">
        Enter the source site's URL and its <code>API_SECRET</code> (used only to authenticate the
        one-time pull — sent hashed, never stored in plaintext). The import runs in the background
        in paginated batches, so it's safe for years of history.
      </p>
      <form id="import-form" class="stack">
        <label>Source URL <input name="sourceUrl" type="url" placeholder="https://my-old-site.herokuapp.com" required /></label>
        <label>API_SECRET <input name="apiSecret" type="password" placeholder="leave blank if source has no secret" /></label>
        <div class="row">
          ${COLLECTIONS.map(
            (c) => `<label style="flex-direction: row; align-items: center; gap: 6px">
              <input type="checkbox" name="collections" value="${c}" checked /> ${c}
            </label>`
          ).join("")}
        </div>
        <button class="primary" type="submit">Start import</button>
      </form>
      <div id="import-status" class="muted" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="section-title">Import jobs</div>
      <table>
        <thead><tr><th>Source</th><th>Status</th><th>Progress</th><th>Updated</th></tr></thead>
        <tbody id="jobs-body"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
      </table>
    </div>

    <div class="card">
      <div class="section-title">API clients (subjects)</div>
      <p class="muted">Issue scoped access tokens for uploader apps or followers instead of sharing the master secret.</p>
      <form id="subject-form" class="row">
        <input name="name" placeholder="e.g. xdrip-uploader" required />
        <label style="flex-direction: row; align-items: center; gap: 6px"><input type="checkbox" name="roles" value="careportal" /> careportal</label>
        <label style="flex-direction: row; align-items: center; gap: 6px"><input type="checkbox" name="roles" value="readable" checked /> readable</label>
        <label style="flex-direction: row; align-items: center; gap: 6px"><input type="checkbox" name="roles" value="admin" /> admin</label>
        <button class="primary" type="submit">Create token</button>
      </form>
      <div id="new-token" style="margin-top:10px"></div>
      <table style="margin-top:14px">
        <thead><tr><th>Name</th><th>Roles</th><th>Created</th></tr></thead>
        <tbody id="subjects-body"><tr><td colspan="3" class="muted">Loading…</td></tr></tbody>
      </table>
    </div>
  `;

  const importForm = container.querySelector("#import-form");
  const importStatus = container.querySelector("#import-status");
  const jobsBody = container.querySelector("#jobs-body");
  const subjectForm = container.querySelector("#subject-form");
  const subjectsBody = container.querySelector("#subjects-body");
  const newToken = container.querySelector("#new-token");

  async function loadJobs() {
    try {
      const jobs = await api("/api/v1/admin/import");
      jobsBody.innerHTML = jobs.length
        ? jobs
            .map(
              (j) => `<tr>
            <td>${j.sourceUrl}</td>
            <td><span class="badge ${j.status}">${j.status}</span></td>
            <td>${Object.entries(j.progress)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ")}</td>
            <td>${new Date(j.updatedAt + "Z").toLocaleString()}</td>
          </tr>`
            )
            .join("")
        : `<tr><td colspan="4" class="muted">No imports yet</td></tr>`;
    } catch (err) {
      jobsBody.innerHTML = `<tr><td colspan="4" class="muted">${err.message}</td></tr>`;
    }
  }

  async function loadSubjects() {
    try {
      const subjects = await api("/api/v1/admin/subjects");
      subjectsBody.innerHTML = subjects.length
        ? subjects
            .map(
              (s) => `<tr><td>${s.name}</td><td>${s.roles.join(", ")}</td><td>${new Date(s.created_at + "Z").toLocaleString()}</td></tr>`
            )
            .join("")
        : `<tr><td colspan="3" class="muted">None yet</td></tr>`;
    } catch (err) {
      subjectsBody.innerHTML = `<tr><td colspan="3" class="muted">${err.message}</td></tr>`;
    }
  }

  importForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(importForm);
    const collections = form.getAll("collections");
    const payload = { sourceUrl: form.get("sourceUrl"), apiSecret: form.get("apiSecret") || undefined, collections };
    importStatus.textContent = "Starting…";
    try {
      const job = await api("/api/v1/admin/import", { method: "POST", body: JSON.stringify(payload) });
      importStatus.textContent = `Import ${job.jobId} started.`;
      loadJobs();
    } catch (err) {
      importStatus.textContent = `Failed: ${err.message}`;
    }
  });

  subjectForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(subjectForm);
    const roles = form.getAll("roles");
    try {
      const subject = await api("/api/v1/admin/subjects", {
        method: "POST",
        body: JSON.stringify({ name: form.get("name"), roles }),
      });
      newToken.innerHTML = `<div class="token-box">Token for <strong>${subject.name}</strong> (shown once): ${subject.accessToken}</div>`;
      subjectForm.reset();
      loadSubjects();
    } catch (err) {
      newToken.innerHTML = `<div class="muted">Failed: ${err.message}</div>`;
    }
  });

  await Promise.all([loadJobs(), loadSubjects()]);
  const pollId = setInterval(loadJobs, 4000);
  return () => clearInterval(pollId);
}
