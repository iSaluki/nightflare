import { Hono } from "hono";
import type { Env } from "../types";
import { authenticate, canRead, canWrite, canAny, defaultRoleNames } from "../lib/auth";

export const statusRoute = new Hono<{ Bindings: Env }>();

const VERSION = "0.1.0";

// The vendored client does exact-string comparisons (`settings.units ===
// 'mmol'`) everywhere it decides how to scale/format a BG value — it never
// just checks "does this look like mmol". Stock Nightscout's server always
// normalized DISPLAY_UNITS this same way (lib/server/env.js), so an operator
// free-typing "mmol/L" (as the wrangler.toml comment for this var literally
// suggests) still gets correctly recognized rather than silently falling
// back to mg/dl display.
function normalizeUnits(raw: string | undefined): string {
  return raw && raw.toLowerCase().includes("mmol") ? "mmol" : "mg/dl";
}

statusRoute.get("/", async (c) => {
  const auth = await authenticate(c);
  const now = new Date();
  const enable = c.env.ENABLE || "";
  const apiEnabled = Boolean(c.env.API_SECRET);

  const [major, minor, patch] = VERSION.split(".").map(Number);
  const versionNum = 10000 * (major || 0) + 100 * (minor || 0) + (patch || 0);

  return c.json({
    status: "ok",
    // Nightscout's client polls this on boot and refuses to finish loading
    // until it sees 'loaded' — we have no async warmup, so it's always so.
    runtimeState: "loaded",
    name: "nightflare",
    version: VERSION,
    versionNum,
    serverTime: now.toISOString(),
    serverTimeEpoch: now.getTime(),
    apiEnabled,
    careportalEnabled: apiEnabled && enable.indexOf("careportal") > -1,
    boluscalcEnabled: apiEnabled && enable.indexOf("boluscalc") > -1,
    settings: {
      units: normalizeUnits(c.env.DISPLAY_UNITS),
      timeFormat: 12,
      nightMode: false,
      editMode: true,
      showRawbg: "never",
      customTitle: c.env.SITE_TITLE || "Nightscout",
      theme: "colors",
      language: "en",
      showPlugins: enable,
      enable,
      authDefaultRoles: defaultRoleNames(c.env).join(" "),
      thresholds: { bgHigh: 260, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 },
    },
    extendedSettings: {},
    authorized: auth.authenticated
      ? { subject: auth.subjectName, permissions: auth.permissions, isAdmin: auth.isAdmin }
      : null,
  });
});

export const adminNotifiesRoute = new Hono<{ Bindings: Env }>();

// We don't implement server-pushed admin notifications (stale-uploader
// alerts, etc.) — this just satisfies the client's boot-time poll so it
// doesn't log a 404 on every page load.
adminNotifiesRoute.get("/", async (c) => {
  return c.json({ status: 200, message: { notifies: [], notifyCount: 0 } });
});

export const verifyAuthRoute = new Hono<{ Bindings: Env }>();

// Matches lib/api/verifyauth.js's exact response shape — the vendored
// client's hashauth.js reads response.message.{canRead,canWrite,isAdmin,...}.
verifyAuthRoute.get("/", async (c) => {
  const auth = await authenticate(c);
  const isAdminPerm = auth.isAdmin || canAny(auth, ["*:*:admin"]);
  const authorized = canRead(auth) && !auth.usedDefaults;

  return c.json({
    status: 200,
    message: {
      canRead: canRead(auth),
      canWrite: canWrite(auth),
      isAdmin: isAdminPerm,
      message: authorized ? "OK" : "UNAUTHORIZED",
      // The vendored client treats these as distinct auth *methods*, not
      // just "authenticated or not": rolefound: 'FOUND' means "a per-subject
      // token matched a role", which (combined with "remember this device")
      // triggers a page reload right after login that master-secret logins
      // were never meant to go through — reporting it for master-secret auth
      // too made every "remember this device" master-secret login reload
      // unexpectedly, sometimes visibly looping if that reload didn't
      // cleanly restore the session.
      rolefound: auth.authenticated && !auth.isMasterSecret ? "FOUND" : "NOTFOUND",
      permissions: auth.usedDefaults ? "DEFAULT" : "ROLE",
    },
  });
});
