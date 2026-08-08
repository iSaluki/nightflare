"use strict";

let cachedRoles = [];

function roleChips(names) {
  if (!names || names.length === 0) return '<span class="chip">none</span>';
  return names.map((n) => `<span class="chip">${escapeHtml(n)}</span>`).join("");
}

async function loadSubjects() {
  const body = document.getElementById("subjects-body");
  try {
    const subjects = await apiFetch("/api/v2/authorization/subjects");
    if (!subjects.length) {
      body.innerHTML = `<tr><td colspan="5" class="empty-state">No subjects yet — add one to issue an access token for an uploader, follower, or watch app.</td></tr>`;
      return;
    }
    body.innerHTML = subjects
      .map(
        (s) => `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${roleChips(s.roles)}</td>
          <td class="wrap">${escapeHtml(s.notes || "")}</td>
          <td><code class="token-cell" data-token="${escapeHtml(s.accessToken)}">••••••••••</code></td>
          <td class="row-actions">
            <button class="icon-only" data-reveal="${escapeHtml(s.accessToken)}" title="Reveal token">👁</button>
            <button class="icon-only" data-edit-subject='${escapeHtml(JSON.stringify(s))}' title="Edit">✎</button>
            <button class="icon-only danger" data-delete-subject="${s._id}" title="Delete">✕</button>
          </td>
        </tr>`
      )
      .join("");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="5" class="empty-state">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadRoles() {
  const body = document.getElementById("roles-body");
  try {
    const roles = await apiFetch("/api/v2/authorization/roles");
    cachedRoles = roles;
    if (!roles.length) {
      body.innerHTML = `<tr><td colspan="4" class="empty-state">No roles.</td></tr>`;
      return;
    }
    body.innerHTML = roles
      .map((r) => {
        const isBuiltIn = !r._id;
        return `
        <tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${roleChips(r.permissions)}</td>
          <td class="wrap">${escapeHtml(r.notes || "")}</td>
          <td class="row-actions">
            ${
              isBuiltIn
                ? '<span class="chip">built-in</span>'
                : `<button class="icon-only" data-edit-role='${escapeHtml(JSON.stringify(r))}' title="Edit">✎</button>
                   <button class="icon-only danger" data-delete-role="${r._id}" title="Delete">✕</button>`
            }
          </td>
        </tr>`;
      })
      .join("");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="4" class="empty-state">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function refreshGate() {
  const gate = document.getElementById("admin-gate");
  const content = document.getElementById("admin-content");
  if (!getCredential()) {
    gate.style.display = "";
    content.style.display = "none";
    return false;
  }
  try {
    const result = await apiFetch("/api/v1/verifyauth");
    if (!result?.message?.isAdmin) {
      document.getElementById("admin-gate-notice").textContent =
        "Signed in, but this credential isn't an admin. Sign in with the master API secret to manage subjects and roles.";
      gate.style.display = "";
      content.style.display = "none";
      return false;
    }
  } catch {
    gate.style.display = "";
    content.style.display = "none";
    return false;
  }
  gate.style.display = "none";
  content.style.display = "";
  return true;
}

async function refreshAll() {
  const ok = await refreshGate();
  if (!ok) return;
  await Promise.all([loadSubjects(), loadRoles()]);
}

// ---------- subject modal ----------

document.getElementById("add-subject-btn").addEventListener("click", () => {
  document.getElementById("subject-modal-title").textContent = "Add subject";
  document.getElementById("subject-id").value = "";
  document.getElementById("subject-name").value = "";
  document.getElementById("subject-roles").value = "";
  document.getElementById("subject-notes").value = "";
  document.getElementById("subject-status").textContent = "";
  openModal("subject-backdrop");
});

document.getElementById("subjects-body").addEventListener("click", async (e) => {
  const revealBtn = e.target.closest("[data-reveal]");
  if (revealBtn) {
    const cell = revealBtn.closest("tr").querySelector(".token-cell");
    cell.textContent = cell.dataset.token;
    return;
  }
  const editBtn = e.target.closest("[data-edit-subject]");
  if (editBtn) {
    const s = JSON.parse(editBtn.dataset.editSubject);
    document.getElementById("subject-modal-title").textContent = "Edit subject";
    document.getElementById("subject-id").value = s._id;
    document.getElementById("subject-name").value = s.name;
    document.getElementById("subject-roles").value = (s.roles || []).join(", ");
    document.getElementById("subject-notes").value = s.notes || "";
    document.getElementById("subject-status").textContent = "";
    openModal("subject-backdrop");
    return;
  }
  const deleteBtn = e.target.closest("[data-delete-subject]");
  if (deleteBtn) {
    if (!confirm("Delete this subject? Its access token will stop working immediately.")) return;
    try {
      await apiFetch(`/api/v2/authorization/subjects/${deleteBtn.dataset.deleteSubject}`, { method: "DELETE" });
      loadSubjects();
    } catch (err) {
      alert(`Failed: ${err.message}`);
    }
  }
});

document.getElementById("subject-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("subject-id").value;
  const params = new URLSearchParams();
  params.set("name", document.getElementById("subject-name").value.trim());
  params.set("notes", document.getElementById("subject-notes").value.trim());
  document
    .getElementById("subject-roles")
    .value.split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .forEach((r) => params.append("roles", r));
  if (id) params.set("_id", id);

  const status = document.getElementById("subject-status");
  status.textContent = "Saving…";
  try {
    await apiFetchForm("/api/v2/authorization/subjects", params, id ? "PUT" : "POST");
    closeModal("subject-backdrop");
    loadSubjects();
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  }
});

// ---------- role modal ----------

document.getElementById("add-role-btn").addEventListener("click", () => {
  document.getElementById("role-modal-title").textContent = "Add role";
  document.getElementById("role-id").value = "";
  document.getElementById("role-name").value = "";
  document.getElementById("role-permissions").value = "";
  document.getElementById("role-notes").value = "";
  document.getElementById("role-status").textContent = "";
  openModal("role-backdrop");
});

document.getElementById("roles-body").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit-role]");
  if (editBtn) {
    const r = JSON.parse(editBtn.dataset.editRole);
    document.getElementById("role-modal-title").textContent = "Edit role";
    document.getElementById("role-id").value = r._id;
    document.getElementById("role-name").value = r.name;
    document.getElementById("role-permissions").value = (r.permissions || []).join(", ");
    document.getElementById("role-notes").value = r.notes || "";
    document.getElementById("role-status").textContent = "";
    openModal("role-backdrop");
    return;
  }
  const deleteBtn = e.target.closest("[data-delete-role]");
  if (deleteBtn) {
    if (!confirm("Delete this role? Subjects using it will lose those permissions.")) return;
    try {
      await apiFetch(`/api/v2/authorization/roles/${deleteBtn.dataset.deleteRole}`, { method: "DELETE" });
      loadRoles();
    } catch (err) {
      alert(`Failed: ${err.message}`);
    }
  }
});

document.getElementById("role-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("role-id").value;
  const params = new URLSearchParams();
  params.set("name", document.getElementById("role-name").value.trim());
  params.set("notes", document.getElementById("role-notes").value.trim());
  document
    .getElementById("role-permissions")
    .value.split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((p) => params.append("permissions", p));
  if (id) params.set("_id", id);

  const status = document.getElementById("role-status");
  status.textContent = "Saving…";
  try {
    await apiFetchForm("/api/v2/authorization/roles", params, id ? "PUT" : "POST");
    closeModal("role-backdrop");
    loadRoles();
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  }
});

window.addEventListener("nf-auth-changed", refreshAll);
wireTopbar();
refreshAll();
