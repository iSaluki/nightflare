import type { Context } from "hono";
import { sha1Hex, timingSafeEqual, hmacSha256Hex } from "./crypto";
import { signJwt, verifyJwt } from "./jwt";
import type { Env } from "../types";

export interface AuthResult {
  /** True only when a real credential (master secret or a subject
   * token/JWT) was presented and matched — NOT when we merely fell back to
   * the default anonymous role. Mirrors Nightscout's `!result.defaults`. */
  authenticated: boolean;
  isAdmin: boolean;
  subjectName: string;
  permissions: string[];
  usedDefaults: boolean;
  /** True when `authenticated` came from the master API_SECRET, as opposed
   * to a per-subject access token/JWT. The vendored client's hashauth.js
   * treats these as meaningfully different: it only sets its own
   * `tokenauthenticated` flag (which, combined with "remember this
   * device", triggers a page reload right after login) for subject-token
   * auth — verifyauth's `rolefound` is how it tells the two apart. */
  isMasterSecret: boolean;
}

// Unlike stock Nightscout (which defaults AUTH_DEFAULT_ROLES to "readable" --
// glucose data readable by anyone with the URL, no token needed), an unset
// AUTH_DEFAULT_ROLES here defaults to "denied": every collection route
// checks permissions *before* touching D1, so an unauthenticated request
// never even queries for entries/treatments/etc., let alone returns them.
// Deployments that want the old anonymous-read behavior back can still set
// AUTH_DEFAULT_ROLES="readable" explicitly.
const FALLBACK_DEFAULT_ROLE = "denied";

export function defaultRoleNames(env: Env): string[] {
  const raw = env.AUTH_DEFAULT_ROLES?.trim();
  if (!raw) return [FALLBACK_DEFAULT_ROLE];
  // Space-separated to match this codebase's other list-style vars (ENABLE,
  // showPlugins) and stock Nightscout's own AUTH_DEFAULT_ROLES convention;
  // commas accepted too since it's an easy thing to type out of habit.
  const names = raw
    .split(/[\s,]+/)
    .map((n) => n.trim())
    .filter(Boolean);
  return names.length > 0 ? names : [FALLBACK_DEFAULT_ROLE];
}

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

/** True if ANY of the given permissions is granted — mirrors shiro-trie's
 * checkMultiple('api:*:create,update,delete', ...) comma-expansion. */
export function canAny(auth: AuthResult, required: string[]): boolean {
  return required.some((r) => can(auth, r));
}

export function canRead(auth: AuthResult): boolean {
  return canAny(auth, ["*:*:read"]);
}
export function canWrite(auth: AuthResult): boolean {
  return canAny(auth, ["*:*:create", "*:*:update", "*:*:delete", "*:*:write"]);
}
export function canWriteTreatments(auth: AuthResult): boolean {
  return canAny(auth, ["api:treatments:create", "api:treatments:update", "api:treatments:delete"]);
}

interface SubjectRow {
  id: string;
  name: string;
  role_names: string;
}

interface RoleRow {
  name: string;
  permissions: string;
}

async function loadRolePermissions(db: D1Database, roleNames: string[]): Promise<string[]> {
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

async function defaultPermissions(env: Env): Promise<string[]> {
  return loadRolePermissions(env.DB, defaultRoleNames(env));
}

/** Deterministically derives a subject's access token from its id and the
 * deployment's master secret — recomputable any time, never stored raw. */
export async function deriveAccessToken(env: Env, subjectId: string, subjectName: string): Promise<string> {
  const digest = await hmacSha256Hex(env.API_SECRET || "", subjectId);
  const slug = subjectName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "subject";
  return `${slug}-${digest.slice(0, 16)}`;
}

async function findSubjectByToken(env: Env, presented: string): Promise<{ row: SubjectRow; permissions: string[] } | null> {
  const { results } = await env.DB.prepare("SELECT id, name, role_names FROM auth_subjects").all<SubjectRow>();
  for (const row of results ?? []) {
    const expected = await deriveAccessToken(env, row.id, row.name);
    if (timingSafeEqual(expected, presented)) {
      const permissions = await loadRolePermissions(env.DB, JSON.parse(row.role_names));
      return { row, permissions };
    }
  }
  return null;
}

/** Resolves a subject from either a raw access token or a JWT wrapping one
 * (`{accessToken}` payload), matching Nightscout's dual acceptance of both
 * forms via `authorization.resolveAccessToken`. */
async function resolveToken(env: Env, presented: string): Promise<{ row: SubjectRow; permissions: string[] } | null> {
  const decoded = await verifyJwt(presented, env.API_SECRET || "");
  const accessToken = typeof decoded?.accessToken === "string" ? decoded.accessToken : presented;
  return findSubjectByToken(env, accessToken);
}

async function buildResult(
  env: Env,
  opts: { authenticated: boolean; isAdmin: boolean; subjectName: string; permissions: string[]; isMasterSecret?: boolean }
): Promise<AuthResult> {
  if (opts.authenticated) {
    return { ...opts, isMasterSecret: opts.isMasterSecret ?? false, usedDefaults: false };
  }
  const defaults = await defaultPermissions(env);
  return { authenticated: false, isAdmin: false, subjectName: "anonymous", permissions: defaults, isMasterSecret: false, usedDefaults: true };
}

/** Resolves the caller's identity/permissions from (in priority order):
 *  1. `api-secret` header equal to sha1(master API_SECRET)  -> full admin
 *  2. `Authorization: Bearer <jwt>` header wrapping a subject access token
 *  3. `api-secret` header or `token`/`secret` query param matching a
 *     subject's derived access token -> that subject's role permissions
 *  4. nothing presented -> anonymous, falls back to whatever role(s)
 *     AUTH_DEFAULT_ROLES names (comma-separated), or "denied" if unset. */
export async function authenticate(c: Context<{ Bindings: Env }>): Promise<AuthResult> {
  const headerSecret = c.req.header("api-secret");
  const bearer = c.req.header("Authorization");
  const queryToken = c.req.query("token") || c.req.query("secret");

  if (c.env.API_SECRET && headerSecret) {
    const expected = await sha1Hex(c.env.API_SECRET);
    if (timingSafeEqual(headerSecret.toLowerCase(), expected)) {
      return buildResult(c.env, { authenticated: true, isAdmin: true, subjectName: "admin", permissions: ["*"], isMasterSecret: true });
    }
  }

  if (bearer?.startsWith("Bearer ")) {
    const found = await resolveToken(c.env, bearer.slice("Bearer ".length).trim());
    if (found) {
      return buildResult(c.env, {
        authenticated: true,
        isAdmin: found.permissions.includes("*"),
        subjectName: found.row.name,
        permissions: found.permissions,
      });
    }
  }

  const presentedToken = queryToken || headerSecret;
  if (presentedToken) {
    const found = await resolveToken(c.env, presentedToken);
    if (found) {
      return buildResult(c.env, {
        authenticated: true,
        isAdmin: found.permissions.includes("*"),
        subjectName: found.row.name,
        permissions: found.permissions,
      });
    }
  }

  return buildResult(c.env, { authenticated: false, isAdmin: false, subjectName: "anonymous", permissions: [] });
}

/** Same resolution as `authenticate`, but for callers with raw credential
 * values instead of a Hono Context — used by the RealtimeHub Durable
 * Object's websocket 'authorize' handler. */
export async function resolveCredentials(
  env: Env,
  creds: { secretHash?: string | null; token?: string | null }
): Promise<AuthResult> {
  if (env.API_SECRET && creds.secretHash) {
    const expected = await sha1Hex(env.API_SECRET);
    if (timingSafeEqual(creds.secretHash.toLowerCase(), expected)) {
      return buildResult(env, { authenticated: true, isAdmin: true, subjectName: "admin", permissions: ["*"], isMasterSecret: true });
    }
  }

  if (creds.token) {
    const found = await resolveToken(env, creds.token);
    if (found) {
      return buildResult(env, {
        authenticated: true,
        isAdmin: found.permissions.includes("*"),
        subjectName: found.row.name,
        permissions: found.permissions,
      });
    }
  }

  return buildResult(env, { authenticated: false, isAdmin: false, subjectName: "anonymous", permissions: [] });
}

/** Issues the signed JWT Nightscout's `/api/v2/authorization/request/:accessToken`
 * returns, wrapping the subject's derived access token. */
export async function issueAuthorization(
  env: Env,
  accessToken: string
): Promise<{ token: string; sub: string; permissionGroups: string[][]; iat: number; exp: number } | null> {
  const found = await findSubjectByToken(env, accessToken);
  if (!found) return null;
  const { token, iat, exp } = await signJwt({ accessToken }, env.API_SECRET || "");
  const roleNames: string[] = JSON.parse(found.row.role_names);
  const permissionGroups: string[][] = [];
  for (const name of roleNames) {
    const role = await env.DB.prepare("SELECT permissions FROM auth_roles WHERE name = ?").bind(name).first<{
      permissions: string;
    }>();
    permissionGroups.push(role ? JSON.parse(role.permissions) : []);
  }
  return { token, sub: found.row.name, permissionGroups, iat, exp };
}
