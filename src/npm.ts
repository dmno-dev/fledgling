import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface PublishOptions {
  dryRun: boolean;
  otp?: string;
  tag?: string;
}

export interface TrustOptions {
  provider: 'github' | 'gitlab' | 'circleci';
  /** "owner/repo" (github) or "group/project" (gitlab) */
  repo: string;
  /** publishing workflow / pipeline filename */
  workflow: string;
  env?: string;
  allowStage?: boolean;
  dryRun: boolean;
}

export function npmWhoami(): string | null {
  try {
    return execFileSync('npm', ['whoami'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Is the name claimed on npm (any version)? */
export function packageExists(name: string): boolean {
  try {
    execFileSync('npm', ['view', name, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** Does the package already have a trusted publisher configured? */
export function trustConfigured(name: string): boolean {
  try {
    const out = execFileSync('npm', ['trust', 'list', name, '--json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out || '[]');
    const list = Array.isArray(parsed) ? parsed : (parsed.trusted ?? parsed.relationships ?? []);
    return Array.isArray(list) && list.length > 0;
  } catch {
    return false;
  }
}

/** Publish a package.json-only placeholder from a throwaway dir (claims the name). */
export function publishPlaceholder(manifest: Record<string, any>, opts: PublishOptions): void {
  const dir = mkdtempSync(join(tmpdir(), 'newdle-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const args = ['publish', '--access', 'public'];
    if (opts.dryRun) args.push('--dry-run');
    if (opts.otp) args.push(`--otp=${opts.otp}`);
    if (opts.tag) args.push(`--tag=${opts.tag}`);
    execFileSync('npm', args, { cwd: dir, stdio: 'inherit' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Configure trusted publishing via `npm trust <provider>`. */
export function configureTrust(name: string, opts: TrustOptions): void {
  if (opts.provider === 'circleci') {
    throw new Error('CircleCI needs org/project/pipeline IDs — run `npm trust circleci` manually for now.');
  }
  const args = ['trust', opts.provider, name, '--file', opts.workflow];
  args.push(opts.provider === 'gitlab' ? '--project' : '--repo', opts.repo);
  if (opts.env) args.push('--env', opts.env);
  args.push('--allow-publish');
  if (opts.allowStage) args.push('--allow-stage-publish');
  args.push(opts.dryRun ? '--dry-run' : '-y');
  execFileSync('npm', args, { stdio: 'inherit' });
}
