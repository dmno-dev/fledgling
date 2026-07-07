import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pkg } from './workspace.js';

/**
 * JSR management API (https://api.jsr.io) client + helpers, the JSR analogue of npm.ts.
 *
 * JSR's model differs from npm's in ways that shape this module:
 *  - There is no "create on first publish" — every package must be *created* up front
 *    (a metadata record with no versions) via `POST /scopes/{scope}/packages`.
 *  - OIDC trusted publishing is just a repo link (`PATCH githubRepository`) — no
 *    per-provider/workflow/environment config, and GitHub-only today. Any workflow in
 *    the linked repo can then publish token-lessly (`npx jsr publish`).
 *  - Auth is a bearer token (jsr.io → Account → Tokens) — none of npm's 2FA machinery.
 *    The token must be FULL access: one restricted to "package publish" can publish
 *    versions but 403s (`missingPermission`) on create/link, which are management ops.
 *    It's used once, locally — it does not go into CI.
 */

export const JSR_API = 'https://api.jsr.io';

/** Pause between packages — JSR's management API 429s bulk claims after only a few calls. */
export const JSR_COOLDOWN_MS = 1000;
const MAX_RETRIES = 6; // 429 backoff attempts per request

// JSR asks management-API clients to identify themselves ("<tool>/<version>; <url>") and
// reserves the right to block tools that don't — so we send a real User-Agent.
declare const __VERSION__: string;
const USER_AGENT = `fledgling/${typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0'}; https://github.com/dmno-dev/fledgling`;

/** A JSR package identity: `@scope/name`, split for API paths (which take them bare). */
export interface JsrName {
  scope: string;
  name: string;
  /** "@scope/name" */
  full: string;
}

export interface JsrResponse {
  status: number;
  ok: boolean;
  body: string;
}

export interface JsrClient {
  request(method: string, path: string, body?: unknown): Promise<JsrResponse>;
  /** The token's display name (`GET /user`), or null if it can't be read. */
  whoami(): Promise<string | null>;
  /** Can this token manage `scope`? (`GET /user/member/{scope}` — 200 = member.) */
  scopeAccess(scope: string): Promise<'ok' | 'bad-token' | 'no-access'>;
  /** Is the name claimed on JSR? (404 = free.) */
  packageExists(n: JsrName): Promise<boolean>;
  createPackage(n: JsrName): Promise<JsrResponse>;
  /** Link the GitHub repo — this is what enables token-less OIDC publishing from CI. */
  linkRepo(n: JsrName, owner: string, repo: string): Promise<JsrResponse>;
}

/**
 * Rate-limit-aware client. Every request retries 429s honouring `Retry-After` when
 * present, else exponential backoff (capped 30s); `onRetry` lets the UI narrate waits.
 */
export function jsrClient(token?: string, onRetry?: (waitMs: number) => void): JsrClient {
  async function request(method: string, path: string, body?: unknown, attempt = 0): Promise<JsrResponse> {
    const res = await fetch(`${JSR_API}${path}`, {
      method,
      headers: {
        'user-agent': USER_AGENT,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 30_000);
      onRetry?.(wait);
      await sleep(wait);
      return request(method, path, body, attempt + 1);
    }
    return { status: res.status, ok: res.ok, body: await res.text() };
  }

  return {
    request,
    async whoami() {
      try {
        const res = await request('GET', '/user');
        if (!res.ok) return null;
        const user = JSON.parse(res.body);
        return user?.name ?? null;
      } catch {
        return null;
      }
    },
    async scopeAccess(scope) {
      const res = await request('GET', `/user/member/${scope}`);
      if (res.status === 200) return 'ok';
      if (res.status === 401) return 'bad-token';
      return 'no-access';
    },
    async packageExists(n) {
      return (await request('GET', `/scopes/${n.scope}/packages/${n.name}`)).status === 200;
    },
    createPackage(n) {
      return request('POST', `/scopes/${n.scope}/packages`, { package: n.name });
    },
    linkRepo(n, owner, repo) {
      return request('PATCH', `/scopes/${n.scope}/packages/${n.name}`, {
        githubRepository: { owner, name: repo },
      });
    },
  };
}

/**
 * JSR caps NEW packages at 20 per scope per rolling week. Once hit, every remaining
 * create fails the same way — callers should stop and report, not grind through.
 */
export function isWeeklyLimit(res: JsrResponse): boolean {
  return res.status === 400 && res.body.includes('weeklyPackageLimitExceeded');
}

/** A short human reason from a JSR error body (`{ code, message }`), else the raw body. */
export function jsrErrorReason(res: JsrResponse): string {
  try {
    const parsed = JSON.parse(res.body);
    if (parsed?.code === 'missingPermission') {
      return 'token lacks permission — claim/link need a FULL-access token, not "package publish"';
    }
    if (parsed?.message) return String(parsed.message);
  } catch {
    /* not JSON */
  }
  return res.body || `HTTP ${res.status}`;
}

/** Parse "@scope/name" into parts; null if it isn't that shape. */
export function parseJsrName(full: string): JsrName | null {
  const m = full.match(/^@([^/]+)\/([^/]+)$/);
  return m ? { scope: m[1], name: m[2], full } : null;
}

/**
 * Validate against JSR's naming rules (lowercase letters/digits/hyphens, starting with
 * a letter, 2+ chars). Format only, and looser than the server — the API stays
 * authoritative for length caps etc.
 */
export function validateJsrName(n: JsrName): string | undefined {
  for (const [what, part] of [['scope', n.scope], ['name', n.name]] as const) {
    if (part.length < 2) return `JSR ${what} "${part}" is too short (2+ characters)`;
    if (!/^[a-z][a-z0-9-]*$/.test(part) || part.endsWith('-')) {
      return `"${part}" isn't a valid JSR ${what} — lowercase letters, digits, and inner hyphens only`;
    }
  }
  return undefined;
}

/** The parsed jsr.json / deno.json in `dir` that carries a `name`, if any. */
function existingManifest(dir: string): { file: string; manifest: Record<string, any> } | null {
  for (const f of ['jsr.json', 'deno.json']) {
    const file = join(dir, f);
    if (!existsSync(file)) continue;
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (manifest?.name) return { file, manifest };
    } catch {
      /* malformed — treat as absent, scaffolding will report */
    }
  }
  return null;
}

/**
 * The JSR name for a workspace package. Precedence: an existing jsr.json/deno.json
 * `name` (it's what JSR reads at publish time, so it's authoritative) → an explicit
 * scope (flag/config) applied to the npm name's base → the npm name's own scope.
 */
export function resolveJsrName(pkg: Pkg, scopeOverride?: string): { jsr?: JsrName; error?: string } {
  const existing = existingManifest(pkg.dir);
  if (existing) {
    const jsr = parseJsrName(existing.manifest.name);
    return jsr ? { jsr } : { error: `${existing.file} has a name that isn't @scope/name: "${existing.manifest.name}"` };
  }
  const scoped = parseJsrName(pkg.name);
  const scope = scopeOverride?.replace(/^@/, '') ?? scoped?.scope;
  if (!scope) {
    return { error: `${pkg.name} — JSR names need a scope; pass --scope, set fledgling.jsr.scope, or add a jsr.json` };
  }
  const base = scoped?.name ?? pkg.name;
  const jsr: JsrName = { scope, name: base, full: `@${scope}/${base}` };
  const invalid = validateJsrName(jsr);
  return invalid ? { error: `${pkg.name} — ${invalid}; add a jsr.json with the JSR name you want` } : { jsr };
}

/**
 * The source entry point for a scaffolded manifest. JSR publishes TS *source*, so
 * prefer the package's `development`/`source` export condition (or a direct .ts
 * export) over built output, then fall back to conventional source locations.
 */
function sourceEntry(pkg: Pkg): { entry: string; exists: boolean } {
  const exports = pkg.manifest.exports;
  const dot = typeof exports === 'string' ? exports : exports?.['.'];
  const fromExports =
    typeof dot === 'string' ? (dot.endsWith('.ts') ? dot : undefined) : (dot?.development ?? dot?.source);
  const candidates = [fromExports, './src/index.ts', './index.ts', './mod.ts'].filter(Boolean) as string[];
  for (const entry of candidates) {
    if (existsSync(join(pkg.dir, entry))) return { entry, exists: true };
  }
  return { entry: candidates[0], exists: false };
}

export interface ManifestResult {
  action: 'ok' | 'created';
  /** Entry point written into a created manifest. */
  entry?: string;
  /** False when the entry file doesn't exist on disk yet — the user needs to edit it. */
  entryExists?: boolean;
}

/**
 * Ensure `pkg` has a JSR manifest, scaffolding jsr.json from package.json when missing.
 * An existing jsr.json/deno.json (with a name) is authoritative and never rewritten.
 */
export function ensureJsrManifest(pkg: Pkg, jsr: JsrName, dryRun: boolean): ManifestResult {
  if (existingManifest(pkg.dir)) return { action: 'ok' };
  const { entry, exists } = sourceEntry(pkg);
  if (!dryRun) {
    const manifest = {
      name: jsr.full,
      version: pkg.manifest.version ?? '0.0.0',
      exports: { '.': entry },
    };
    writeFileSync(join(pkg.dir, 'jsr.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  return { action: 'created', entry, entryExists: exists };
}
