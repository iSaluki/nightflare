import type { Context } from "hono";
import { sha1Hex, sha256Hex, timingSafeEqual } from "./crypto";
import type { Env } from "../types";

export interface AuthResult {
  authenticated: boolean;
  isAdmin: boolean;
  subjectName: string;
  permissions: string[];
}

const ANONYMOUS: AuthResult = {
  authenticated: false,
  isAdmin: false,
  subjectName: "anonymous",
  permissions: [],
};

/** Matches Nightscout's permission strings, e.g. pattern "api:*:read" or "*"
 * against a required permission "api:entries:read". Segments are separated
 * by ":" and "*" matches any single segment (or, as the whole pattern,
 * everything). */
export function permissionAllows(pattern: string, required: string): boolean {
  if (pattern === "*") return true;
  const patternParts = pattern.split(":");
  const requiredParts = required.split(":");
  if (patternParts.length !== requiredParts.length) return false;
  return patternParts.every((p, i) => p === "*" || p === requiredParts[i]);
}

export function can(auth: AuthResult, required: string): boolean {
  if (auth.isAdmin) return true;
  return auth.permissions.some((p) => permissionAllows(p, required));
}

interface SubjectRow {
  id: string;
  name: string;
  role_names: string;
  access_token_hash: string | null;
}

interface RoleRow {
  name: string;
  permissions: string;
}

async function resolveSubjectPermissions(db: D1Database, subject: SubjectRow): Promise<string[]> {
  const roleNames: string[] = JSON.parse(subject.role_names || "[]");
  if (roleNames.length === 0) return [];
  const placeholders = roleNames.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT name, permissions FROM auth_roles WHERE name IN (${placeholders})`)
    .bind(...roleNames)
    .all<RoleRow>();
  const perms = new Set<string>();
  for (const row of results ?? []) {
    for (const p of JSON.parse(row.permissions) as string[]) perms.add(p);
  }
  return Array.from(perms);
}

/** Resolves the caller's identity/permissions from (in priority order):
 *  1. `api-secret` header equal to sha1(master API_SECRET)  -> full admin
 *  2. `api-secret` header or `token`/`secret` query param matching a
 *     subject's hashed access token -> that subject's role permissions
 *  3. nothing presented -> anonymous (Nightscout still allows reads by
 *     default unless AUTH_DEFAULT_ROLES requires auth for everything; we
 *     mirror that default: anonymous gets the "readable" role's perms). */
export async function authenticate(c: Context<{ Bindings: Env }>): Promise<AuthResult> {
  const headerSecret = c.req.header("api-secret");
  const queryToken = c.req.query("token") || c.req.query("secret");

  if (c.env.API_SECRET && headerSecret) {
    const expected = await sha1Hex(c.env.API_SECRET);
    if (timingSafeEqual(headerSecret.toLowerCase(), expected)) {
      return { authenticated: true, isAdmin: true, subjectName: "admin", permissions: ["*"] };
    }
  }

  const presentedToken = queryToken || headerSecret;
  if (presentedToken) {
    const tokenHash = await sha256Hex(presentedToken);
    const subject = await c.env.DB.prepare(
      "SELECT id, name, role_names, access_token_hash FROM auth_subjects WHERE access_token_hash = ?"
    )
      .bind(tokenHash)
      .first<SubjectRow>();
    if (subject) {
      const permissions = await resolveSubjectPermissions(c.env.DB, subject);
      const isAdmin = permissions.includes("*");
      return { authenticated: true, isAdmin, subjectName: subject.name, permissions };
    }
  }

  // Anonymous fallback: grant the built-in "readable" role so GET requests
  // used by dashboards/followers keep working out of the box, same as a
  // freshly-installed Nightscout with AUTH_DEFAULT_ROLES=readable.
  const readable = await c.env.DB.prepare("SELECT permissions FROM auth_roles WHERE name = 'readable'").first<{
    permissions: string;
  }>();
  return { ...ANONYMOUS, permissions: readable ? JSON.parse(readable.permissions) : [] };
}
