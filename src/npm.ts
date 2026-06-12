import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Permission, Provider } from './config.js';

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

/**
 * Existing trusted-publisher configs (npm allows at most one per package).
 *
 * `npm trust list` hits the registry and may require a one-time password. When
 * `interactive` is true we inherit stdin/stderr so npm can run its OTP/web-auth
 * flow (the first trust op authenticates, later ones reuse it); stdout stays
 * piped so we can still parse the JSON. Quiet mode is best-effort and returns
 * `[]` if it can't authenticate.
 */
export function listTrust(name: string, registry?: string, interactive = false): TrustEntry[] {
  try {
    const out = execFileSync('npm', withRegistry(['trust', 'list', name, '--json'], registry), {
      stdio: interactive ? ['inherit', 'pipe', 'inherit'] : ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out); // npm emits a bare object (or array) of { id, type, permissions }
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export function trustConfigured(name: string, registry?: string, interactive = false): boolean {
  return listTrust(name, registry, interactive).length > 0;
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
  args.push(opts.dryRun ? '--dry-run' : '-y');
  execFileSync('npm', args, { stdio: 'inherit' });
}

/** Revoke a trusted-publisher config by id (used by --force to replace one). */
export function revokeTrust(name: string, id: string, registry?: string): void {
  execFileSync('npm', withRegistry(['trust', 'revoke', name, `--id=${id}`], registry), { stdio: 'inherit' });
}
