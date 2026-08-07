import { Hono } from "hono";
import type { Env } from "../types";
import { authenticate } from "../lib/auth";

export const statusRoute = new Hono<{ Bindings: Env }>();

statusRoute.get("/", async (c) => {
  const auth = await authenticate(c);
  const now = new Date();
  return c.json({
    status: "ok",
    name: "nightflare",
    version: "0.1.0",
    serverTime: now.toISOString(),
    serverTimeEpoch: now.getTime(),
    apiEnabled: true,
    careportalEnabled: true,
    boluscalcEnabled: true,
    settings: {
      units: c.env.DISPLAY_UNITS || "mg/dl",
      timeFormat: 12,
      nightMode: false,
      editMode: true,
      showRawbg: "never",
      customTitle: c.env.SITE_TITLE || "Nightflare",
      theme: "colors",
      language: "en",
      showPlugins: c.env.ENABLE || "",
      authDefaultRoles: "readable",
      alarmTypes: ["predict"],
      thresholds: { bgHigh: 260, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 55 },
    },
    extendedSettings: {},
    authorized: auth.authenticated
      ? { subject: auth.subjectName, permissions: auth.permissions, isAdmin: auth.isAdmin }
      : null,
  });
});

export const verifyAuthRoute = new Hono<{ Bindings: Env }>();

verifyAuthRoute.get("/", async (c) => {
  const auth = await authenticate(c);
  return c.json({
    status: auth.authenticated ? 200 : 401,
    message: auth.authenticated ? "OK" : "Unauthorized",
    rc: auth.authenticated ? 200 : 401,
    permissionGroups: [auth.permissions],
  });
});
