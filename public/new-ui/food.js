"use strict";

let allFood = [];
let activeType = "";
let searchTerm = "";

function giLabel(gi) {
  return { 1: "Low", 2: "Medium", 3: "High" }[gi] || "";
}

function renderFood() {
  const body = document.getElementById("food-body");
  const term = searchTerm.trim().toLowerCase();
  const items = allFood.filter((f) => {
    if (activeType && f.type !== activeType) return false;
    if (!term) return true;
    return (f.name || "").toLowerCase().includes(term) || (f.category || "").toLowerCase().includes(term);
  });

  if (items.length === 0) {
    body.innerHTML = `<tr><td colspan="10" class="empty-state">No food items match.</td></tr>`;
    return;
  }

  body.innerHTML = items
    .map(
      (f) => `
      <tr>
        <td>${escapeHtml(f.name || "")}</td>
        <td>${escapeHtml(f.category || "")}</td>
        <td><span class="chip">${escapeHtml(f.type || "food")}</span></td>
        <td>${escapeHtml(f.portion || "")}${f.unit ? " " + escapeHtml(f.unit) : ""}</td>
        <td>${f.carbs ?? ""}</td>
        <td>${f.protein ?? ""}</td>
        <td>${f.fat ?? ""}</td>
        <td>${f.energy ?? ""}</td>
        <td>${giLabel(f.gi)}</td>
        <td class="row-actions">
          <button class="icon-only" data-edit='${escapeHtml(JSON.stringify(f))}' title="Edit">✎</button>
          <button class="icon-only danger" data-delete="${f._id}" title="Delete">✕</button>
        </td>
      </tr>`
    )
    .join("");
}

async function loadFood() {
  const body = document.getElementById("food-body");
  try {
    allFood = await apiFetch("/api/v1/food?count=500");
    renderFood();
  } catch (err) {
    body.innerHTML = `<tr><td colspan="10" class="empty-state">${escapeHtml(err.message)}</td></tr>`;
  }
}

document.getElementById("type-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-type]");
  if (!btn) return;
  document.querySelectorAll("#type-tabs button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  activeType = btn.dataset.type;
  renderFood();
});

document.getElementById("food-search").addEventListener("input", (e) => {
  searchTerm = e.target.value;
  renderFood();
});

function resetFoodForm() {
  document.getElementById("food-id").value = "";
  document.getElementById("food-name").value = "";
  document.getElementById("food-type").value = "food";
  document.getElementById("food-category").value = "";
  document.getElementById("food-portion").value = "";
  document.getElementById("food-unit").value = "";
  document.getElementById("food-gi").value = "";
  document.getElementById("food-carbs").value = "";
  document.getElementById("food-protein").value = "";
  document.getElementById("food-fat").value = "";
  document.getElementById("food-energy").value = "";
  document.getElementById("food-status").textContent = "";
}

document.getElementById("add-food-btn").addEventListener("click", () => {
  resetFoodForm();
  document.getElementById("food-modal-title").textContent = "Add food item";
  openModal("food-backdrop");
});

document.getElementById("food-body").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit]");
  if (editBtn) {
    const f = JSON.parse(editBtn.dataset.edit);
    resetFoodForm();
    document.getElementById("food-modal-title").textContent = "Edit food item";
    document.getElementById("food-id").value = f._id;
    document.getElementById("food-name").value = f.name || "";
    document.getElementById("food-type").value = f.type || "food";
    document.getElementById("food-category").value = f.category || "";
    document.getElementById("food-portion").value = f.portion || "";
    document.getElementById("food-unit").value = f.unit || "";
    document.getElementById("food-gi").value = f.gi || "";
    document.getElementById("food-carbs").value = f.carbs ?? "";
    document.getElementById("food-protein").value = f.protein ?? "";
    document.getElementById("food-fat").value = f.fat ?? "";
    document.getElementById("food-energy").value = f.energy ?? "";
    openModal("food-backdrop");
    return;
  }
  const deleteBtn = e.target.closest("[data-delete]");
  if (deleteBtn) {
    if (!confirm("Delete this food item?")) return;
    try {
      await apiFetch(`/api/v1/food/${deleteBtn.dataset.delete}`, { method: "DELETE" });
      loadFood();
    } catch (err) {
      alert(`Failed: ${err.message}`);
    }
  }
});

document.getElementById("food-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("food-id").value;
  const num = (v) => (v === "" ? undefined : Number(v));
  const payload = {
    name: document.getElementById("food-name").value.trim(),
    type: document.getElementById("food-type").value,
    category: document.getElementById("food-category").value.trim() || undefined,
    portion: document.getElementById("food-portion").value.trim() || undefined,
    unit: document.getElementById("food-unit").value.trim() || undefined,
    gi: num(document.getElementById("food-gi").value),
    carbs: num(document.getElementById("food-carbs").value),
    protein: num(document.getElementById("food-protein").value),
    fat: num(document.getElementById("food-fat").value),
    energy: num(document.getElementById("food-energy").value),
  };
  if (id) payload._id = id;

  const status = document.getElementById("food-status");
  status.textContent = "Saving…";
  try {
    if (id) {
      await apiFetch(`/api/v1/food/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await apiFetch("/api/v1/food", { method: "POST", body: JSON.stringify(payload) });
    }
    closeModal("food-backdrop");
    loadFood();
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  }
});

window.addEventListener("nf-auth-changed", loadFood);
wireTopbar();
loadFood();
