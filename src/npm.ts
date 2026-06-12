import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Permission, Provider } from './config.js';

const execFileP = promisify(execFile);

export interface PublishOptions {
  dryRun: boolean;
  otp?: string;
  tag?: string;
  registry?: string;
}

export interface TrustOptions {
  provider: Provider;
  permissions: Permission;
  registry?: string;
  otp?: string;
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

export interface TrustEntry {
  id?: string;
  type?: string;
  permissions?: string[];
}

/** Append `--registry <url>` when one is configured. */
function withRegistry(args: string[], registry?: string): string[] {
  if (registry) args.push('--registry', registry);
  return args;
}

export function npmWhoami(): string | null {
  try {
    return execFileSync('npm', ['whoami'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
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

function withOtp(args: string[], otp?: string): string[] {
  if (otp) args.push(`--otp=${otp}`);
  return args;
}

/**
 * Existing trusted-publisher configs (npm allows at most one per package).
 * `npm trust list` needs auth + (on 2FA accounts) an OTP — it does NOT prompt,
 * it just errors. Pass `otp`. Returns `[]` if it can't read (or no config).
 */
export function listTrust(name: string, registry?: string, otp?: string): TrustEntry[] {
  try {
    const out = execFileSync('npm', withOtp(withRegistry(['trust', 'list', name, '--json'], registry), otp), {
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

export function trustConfigured(name: string, registry?: string, otp?: string): boolean {
  return listTrust(name, registry, otp).length > 0;
}

/** Whether trust configs are readable right now (auth + OTP valid). Probes with one quiet call. */
export function trustReadable(name: string, registry?: string, otp?: string): boolean {
  try {
    execFileSync('npm', withOtp(withRegistry(['trust', 'list', name, '--json'], registry), otp), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Publish a package.json-only placeholder from a throwaway dir (claims the name). */
export function publishPlaceholder(manifest: Record<string, any>, opts: PublishOptions): void {
  const dir = mkdtempSync(join(tmpdir(), 'fledgling-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const args = ['publish', '--access', 'public'];
    if (opts.dryRun) args.push('--dry-run');
    if (opts.otp) args.push(`--otp=${opts.otp}`);
    if (opts.tag) args.push(`--tag=${opts.tag}`);
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
  withOtp(args, opts.otp);
  args.push(opts.dryRun ? '--dry-run' : '-y');
  execFileSync('npm', args, { stdio: 'inherit' });
}

/** Revoke a trusted-publisher config by id (used by --force to replace one). */
export function revokeTrust(name: string, id: string, registry?: string, otp?: string): void {
  execFileSync('npm', withOtp(withRegistry(['trust', 'revoke', name, `--id=${id}`], registry), otp), { stdio: 'inherit' });
}
