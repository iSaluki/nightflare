import { getStoredSecret, setStoredSecret, checkAuth } from "/lib/api.js";
import { renderDashboard } from "/views/dashboard.js";
import { renderTreatments } from "/views/treatments.js";
import { renderProfile } from "/views/profile.js";
import { renderAdmin } from "/views/admin.js";

const routes = {
  dashboard: renderDashboard,
  treatments: renderTreatments,
  profile: renderProfile,
  admin: renderAdmin,
};

const appEl = document.getElementById("app");
let activeCleanup = null;

async function navigate() {
  const hash = (location.hash || "#/dashboard").slice(2);
  const [tab] = hash.split("/");
  const render = routes[tab] || routes.dashboard;

  document.querySelectorAll(".tabs a").forEach((a) => {
    a.classList.toggle("active", a.dataset.tab === tab);
  });

  if (typeof activeCleanup === "function") activeCleanup();
  appEl.innerHTML = "";
  activeCleanup = await render(appEl);
}

window.addEventListener("hashchange", navigate);

async function refreshAuthButton() {
  const btn = document.getElementById("auth-btn");
  const secret = getStoredSecret();
  if (!secret) {
    btn.textContent = "Sign in";
    btn.classList.remove("signed-in");
    return;
  }
  const ok = await checkAuth();
  btn.textContent = ok ? "Signed in ✓" : "Sign in (invalid)";
  btn.classList.toggle("signed-in", ok);
}

document.getElementById("auth-btn").addEventListener("click", async () => {
  const current = getStoredSecret();
  const next = prompt("Enter your API_SECRET (never sent in plaintext — hashed client-side):", current || "");
  if (next === null) return;
  setStoredSecret(next.trim());
  await refreshAuthButton();
  navigate();
});

refreshAuthButton();
navigate();
