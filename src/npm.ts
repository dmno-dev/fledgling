import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Permission, Provider } from './config.js';

const execFileP = promisify(execFile);

/** 2FA credentials: a static one-time code, or a TOTP secret we generate codes from. */
export interface OtpCreds {
  otp?: string;
  otpSecret?: string;
}

export interface PublishOptions extends OtpCreds {
  dryRun: boolean;
  tag?: string;
  registry?: string;
}

export interface TrustOptions extends OtpCreds {
  provider: Provider;
  permissions: Permission;
  registry?: string;
  dryRun: boolean;
  // github / gitlab
  repo?: string; // owner/repo (github) or group/project (gitlab)
  workflow?: string;
  env?: string;
  // circleci
  orgId?: string;
  projectId?: string;
  pipelineDefinitionId?: string;
  vcsOrigin?: string;
  contextIds?: string[];
}

/** A trusted-publisher config as returned by `npm trust list --json`. */
export interface TrustEntry {
  id?: string;
  type?: string; // github | gitlab | circleci
  permissions?: string[]; // createPackage | createStagedPackage
  // github / gitlab
  file?: string;
  repository?: string; // github
  project?: string; // gitlab
  environment?: string;
  // circleci
  orgId?: string;
  projectId?: string;
  pipelineDefinitionId?: string;
  vcsOrigin?: string;
  contextIds?: string[];
}

/** Append `--registry <url>` when one is configured. */
function withRegistry(args: string[], registry?: string): string[] {
  if (registry) args.push('--registry', registry);
  return args;
}

/** The logged-in npm user for `registry` (login is per-registry), or null if not logged in. */
export function npmWhoami(registry?: string): string | null {
  try {
    return execFileSync('npm', withRegistry(['whoami'], registry), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Minimum npm fledgling needs — `npm trust` + OIDC/staged publishing landed here. */
export const MIN_NPM = '11.15.0';

/** The installed npm version (e.g. "11.15.0"), or null if npm isn't on PATH. */
export function npmVersion(): string | null {
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Compare dotted numeric versions; true when `a` >= `b`. */
function versionGte(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** A helpful error if npm is missing or older than `min`, else null. */
export function checkNpmVersion(min = MIN_NPM): string | null {
  const v = npmVersion();
  if (!v) return 'npm was not found on your PATH. Install Node.js (which bundles npm) and retry.';
  const numeric = v.split('-')[0]; // drop any prerelease suffix
  if (!versionGte(numeric, min)) {
    return `npm ${v} is too old — fledgling needs npm ≥ ${min} (for \`npm trust\` + OIDC publishing). Update with \`npm install -g npm@latest\`.`;
  }
  return null;
}

/** Is the name claimed on npm (any version)? */
export function packageExists(name: string, registry?: string): boolean {
  try {
    execFileSync('npm', withRegistry(['view', name, 'version'], registry), { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** Which of `names` already exist on npm — checked in parallel (capped concurrency). */
export async function publishedNames(names: string[], registry?: string, concurrency = 10): Promise<Set<string>> {
  const found = new Set<string>();
  let i = 0;
  async function worker(): Promise<void> {
    while (i < names.length) {
      const name = names[i++];
      try {
        await execFileP('npm', withRegistry(['view', name, 'version'], registry));
        found.add(name);
      } catch {
        /* not published */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return found;
}

/**
 * Validate a name against npm's package-name rules. Returns an error message to show
 * the user, or undefined if the name is well-formed. (Format only — availability is a
 * separate network check, see `isNameAvailable`.)
 */
export function validatePackageName(name: string): string | undefined {
  if (!name) return 'Enter a package name';
  if (name.length > 214) return 'Too long — npm names are 214 characters max';
  if (name.trim() !== name) return 'No leading or trailing spaces';
  if (/[A-Z]/.test(name)) return 'Must be lowercase';
  const scoped = name.match(/^@([^/]+)\/([^/]+)$/);
  if (name.startsWith('@') && !scoped) return 'Scoped names look like @scope/name';
  const parts = scoped ? [scoped[1], scoped[2]] : [name];
  for (const part of parts) {
    if (!part) return 'Missing scope or name';
    if (/^[._]/.test(part)) return "Can't start with a dot or underscore";
    // npm allows url-safe chars; reject anything that would need encoding.
    if (!/^[a-z0-9._~-]+$/.test(part)) return 'Use letters, numbers, and - . _ ~ only';
  }
  return undefined;
}

/** Registry base URL (no trailing slash) — the configured one, else the public npm registry. */
function registryBase(registry?: string): string {
  return (registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
}

/**
 * Is `name` free to claim on the registry? `true` = available (404), `false` = taken,
 * `null` = couldn't tell (network/registry error — caller should let the user proceed).
 *
 * Uses a direct HTTP HEAD instead of `npm view` so it's fast enough to run interactively
 * (no subprocess, ~one round-trip). The authoritative check still happens at claim time.
 */
export async function isNameAvailable(name: string, registry?: string, timeoutMs = 4000): Promise<boolean | null> {
  // The registry encodes the scope slash as %2f; everything else is path-safe.
  const url = `${registryBase(registry)}/${name.replace('/', '%2f')}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    if (res.status === 404) return true;
    if (res.ok) return false;
    return null; // 4xx/5xx we don't understand → unknown
  } catch {
    return null; // offline, DNS failure, abort, etc.
  } finally {
    clearTimeout(timer);
  }
}

function withOtp(args: string[], otp?: string): string[] {
  if (otp) args.push(`--otp=${otp}`);
  return args;
}

/** Decode an RFC 4648 base32 string (the format authenticator-app secrets use). */
function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Pull the base32 secret out of an `otpauth://…?secret=…` URI (the form password
 * managers often export), or pass a bare base32 secret through unchanged.
 */
function otpSecretValue(s: string): string {
  if (/^otpauth:\/\//i.test(s.trim())) {
    const m = s.match(/[?&]secret=([^&]+)/i);
    if (m) return decodeURIComponent(m[1]);
  }
  return s;
}

/** A current 6-digit TOTP code (RFC 6238, SHA-1/30s — what npm's authenticator 2FA uses). */
export function totp(secret: string, step = 30, digits = 6): string {
  const counter = Math.floor(Date.now() / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(otpSecretValue(secret))).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = hmac.readUInt32BE(offset) & 0x7fffffff;
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

/** The OTP to use for the next npm call: a fresh TOTP from a secret, else the static code. */
function nextOtp(c?: OtpCreds): string | undefined {
  return c?.otpSecret ? totp(c.otpSecret) : c?.otp;
}

/**
 * Run an `npm trust …` command with the terminal fully attached. npm manages 2FA
 * itself — an interactive browser approval, cached for ~5 min — so we just let it
 * use the real stdin/stdout/stderr instead of capturing them (which would suppress
 * that prompt). Throws on non-zero exit.
 */
function runTrust(args: string[]): void {
  execFileSync('npm', args, { stdio: 'inherit' });
}

/**
 * Trigger npm's interactive 2FA once (warming its ~5-min session cache) so the piped
 * trust *reads* that follow don't need to prompt — they can't, since we capture their
 * stdout to parse JSON. Uses an existing package name (a read on a missing name 404s
 * before authenticating, so it wouldn't warm anything). Returns false if auth failed.
 */
export function warmNpmAuth(name: string, registry?: string): boolean {
  try {
    execFileSync('npm', withRegistry(['trust', 'list', name], registry), { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Existing trusted-publisher configs (npm allows at most one per package).
 * `npm trust list` needs 2FA; we capture its stdout to parse the JSON, so it can't run
 * npm's interactive auth itself — warm npm's session cache first (see `warmNpmAuth`),
 * or pass `otp`. Returns `[]` if it can't read (or there's no config).
 */
export function listTrust(name: string, registry?: string, creds?: OtpCreds): TrustEntry[] {
  try {
    const out = execFileSync('npm', withOtp(withRegistry(['trust', 'list', name, '--json'], registry), nextOtp(creds)), {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out); // npm emits a bare object (or array) of { id, type, permissions }
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Publish a package.json-only placeholder from a throwaway dir (claims the name). */
export function publishPlaceholder(manifest: Record<string, any>, opts: PublishOptions): void {
  const dir = mkdtempSync(join(tmpdir(), 'fledgling-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const args = ['publish', '--access', 'public'];
    if (opts.dryRun) args.push('--dry-run');
    if (opts.tag) args.push(`--tag=${opts.tag}`);
    withOtp(args, nextOtp(opts));
    withRegistry(args, opts.registry);
    execFileSync('npm', args, { cwd: dir, stdio: 'inherit' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Configure trusted publishing via `npm trust <provider>` (all providers + options). */
export function configureTrust(name: string, opts: TrustOptions): void {
  const args = ['trust', opts.provider, name];
  if (opts.provider === 'circleci') {
    args.push('--org-id', opts.orgId!);
    args.push('--project-id', opts.projectId!);
    args.push('--pipeline-definition-id', opts.pipelineDefinitionId!);
    args.push('--vcs-origin', opts.vcsOrigin!);
    for (const c of opts.contextIds ?? []) args.push('--context-id', c);
  } else {
    args.push('--file', opts.workflow!);
    args.push(opts.provider === 'gitlab' ? '--project' : '--repo', opts.repo!);
    if (opts.env) args.push('--env', opts.env);
  }
  if (opts.permissions === 'publish' || opts.permissions === 'both') args.push('--allow-publish');
  if (opts.permissions === 'stage' || opts.permissions === 'both') args.push('--allow-stage-publish');
  withRegistry(args, opts.registry);
  withOtp(args, nextOtp(opts));
  args.push(opts.dryRun ? '--dry-run' : '-y');
  runTrust(args);
}

/** Revoke a trusted-publisher config by id (used by --force to replace one). */
export function revokeTrust(name: string, id: string, registry?: string, creds?: OtpCreds): void {
  runTrust(withOtp(withRegistry(['trust', 'revoke', name, `--id=${id}`], registry), nextOtp(creds)));
}
