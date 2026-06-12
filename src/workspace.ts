import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { globSync } from 'tinyglobby';

export interface Pkg {
  name: string;
  dir: string;
  manifest: Record<string, any>;
}

export interface RepoInfo {
  host: 'github' | 'gitlab';
  /** "owner/repo" */
  slug: string;
}

/**
 * Walk up from `start` to the workspace root: the nearest ancestor that declares
 * workspaces (package.json `workspaces` or pnpm-workspace.yaml). Falls back to the
 * nearest package.json (a single-package repo).
 */
export function findWorkspaceRoot(start = process.cwd()): string {
  let dir = resolve(start);
  let firstPkgDir: string | null = null;
  while (true) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      if (!firstPkgDir) firstPkgDir = dir;
      try {
        if (JSON.parse(readFileSync(pj, 'utf8')).workspaces) return dir;
      } catch {
        /* ignore malformed package.json */
      }
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return firstPkgDir ?? resolve(start);
}

/** Discover all non-private, named packages in the workspace at `root`. */
export function discoverPackages(root: string): Pkg[] {
  const patterns = workspacePatterns(root);

  // No workspaces declared → treat root as a single package.
  if (!patterns) {
    const pkg = readManifest(join(root, 'package.json'));
    return pkg ? [{ name: pkg.name, dir: root, manifest: pkg }] : [];
  }

  const matches = globSync(
    patterns.include.map(p => `${p}/package.json`),
    { cwd: root, ignore: patterns.ignore.map(p => `${p}/package.json`) },
  );

  const pkgs: Pkg[] = [];
  for (const rel of matches.sort()) {
    const file = join(root, rel);
    const manifest = readManifest(file);
    if (manifest) pkgs.push({ name: manifest.name, dir: dirname(file), manifest });
  }
  return pkgs;
}

/** Best-effort detect the GitHub/GitLab repo from the git `origin` remote. */
export function detectRepo(root: string): RepoInfo | null {
  let url: string;
  try {
    url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  // git@github.com:owner/repo.git | https://github.com/owner/repo(.git) | ssh://...
  const m = url.match(/(github|gitlab)\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!m) return null;
  return { host: m[1].toLowerCase() as 'github' | 'gitlab', slug: m[2] };
}

function readManifest(file: string): Record<string, any> | null {
  if (!existsSync(file)) return null;
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    if (m.private || !m.name) return null;
    return m;
  } catch {
    return null;
  }
}

function workspacePatterns(root: string): { include: string[]; ignore: string[] } | null {
  const pj = join(root, 'package.json');
  if (existsSync(pj)) {
    try {
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (Array.isArray(ws) && ws.length) return splitPatterns(ws);
    } catch {
      /* ignore */
    }
  }
  const pnpm = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    const pats = parsePnpmWorkspace(readFileSync(pnpm, 'utf8'));
    if (pats.length) return splitPatterns(pats);
  }
  return null;
}

function splitPatterns(patterns: string[]): { include: string[]; ignore: string[] } {
  const include: string[] = [];
  const ignore: string[] = [];
  for (const p of patterns) (p.startsWith('!') ? ignore : include).push(p.replace(/^!/, ''));
  return { include, ignore };
}

/** Minimal pnpm-workspace.yaml parser: the `- 'glob'` entries under `packages:`. */
function parsePnpmWorkspace(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const m = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
    if (m) out.push(m[1].trim());
    else if (/^\S/.test(line)) break; // a new top-level key ends the list
  }
  return out;
}
