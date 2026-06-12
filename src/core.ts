import type { Pkg } from './workspace.js';
import { discoverPackages, findWorkspaceRoot } from './workspace.js';
import { packageExists, trustConfigured, publishPlaceholder, configureTrust } from './npm.js';

export interface Settings {
  dryRun: boolean;
  skipPublish: boolean;
  skipTrust: boolean;
  version: string;
  tag?: string;
  otp?: string;
  provider: 'github' | 'gitlab' | 'circleci';
  repo?: string;
  workflow: string;
  env?: string;
  allowStage: boolean;
}

export type StepStatus = 'done' | 'skip' | 'fail' | 'na';
export interface TargetResult {
  name: string;
  claim: StepStatus;
  trust: StepStatus;
}

/** Both the plain and interactive UIs render progress through this. */
export interface Reporter {
  step(msg: string): void;
  skip(msg: string): void;
  fail(msg: string): void;
}

/** Build the placeholder manifest: descriptive metadata only, no entry points/deps. */
export function placeholderManifest(pkg: Pkg, version: string): Record<string, any> {
  const out: Record<string, any> = { name: pkg.name, version };
  for (const k of ['description', 'keywords', 'license', 'author', 'homepage', 'repository']) {
    if (pkg.manifest[k] !== undefined) out[k] = pkg.manifest[k];
  }
  return out;
}

/** Glob (supports * and ?) anchored against the full package name. */
export function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

/** Package names in the current workspace — used for tab completion and the wizard. */
export function workspacePackages(): Pkg[] {
  return discoverPackages(findWorkspaceRoot());
}

export interface ResolveResult {
  targets: Pkg[];
  error?: string;
}

/** Turn positional selectors (names/globs) into concrete targets. */
export function resolveTargets(discovered: Pkg[], selectors: string[], isNew: boolean, root: string): ResolveResult {
  if (selectors.length === 0) {
    if (isNew) return { targets: [], error: '--new requires a package name, e.g. `newdle @scope/thing --new`' };
    return { targets: discovered };
  }
  const seen = new Set<string>();
  const targets: Pkg[] = [];
  for (const sel of selectors) {
    const matches = discovered.filter(p => globToRegExp(sel).test(p.name));
    if (matches.length === 0) {
      if (isNew && !sel.includes('*') && !sel.includes('?')) {
        matches.push({ name: sel, dir: root, manifest: { name: sel } });
      } else {
        const hint = isNew ? '' : ' (use --new to claim a brand-new name)';
        return { targets: [], error: `No package matches "${sel}".${hint}` };
      }
    }
    for (const m of matches) if (!seen.has(m.name)) (seen.add(m.name), targets.push(m));
  }
  return { targets };
}

/** Claim + trust one package. Reports progress; returns a structured result. */
export function processTarget(t: Pkg, s: Settings, report: Reporter): TargetResult {
  const result: TargetResult = { name: t.name, claim: 'na', trust: 'na' };
  let exists = packageExists(t.name);

  if (!s.skipPublish) {
    if (exists) {
      report.skip(`${t.name} — name already on npm`);
      result.claim = 'skip';
    } else {
      try {
        publishPlaceholder(placeholderManifest(t, s.version), { dryRun: s.dryRun, otp: s.otp, tag: s.tag });
        result.claim = 'done';
        if (!s.dryRun) exists = true;
        report.step(`${t.name} — ${s.dryRun ? 'would claim' : 'claimed'} @${s.version}`);
      } catch {
        report.fail(`${t.name} — claim failed`);
        result.claim = 'fail';
      }
    }
  }

  if (!s.skipTrust) {
    if (!exists && !s.dryRun) {
      report.skip(`${t.name} — trust skipped (name not on npm yet)`);
    } else if (trustConfigured(t.name)) {
      report.skip(`${t.name} — trust already configured`);
      result.trust = 'skip';
    } else {
      try {
        configureTrust(t.name, {
          provider: s.provider,
          repo: s.repo!,
          workflow: s.workflow,
          env: s.env,
          allowStage: s.allowStage,
          dryRun: s.dryRun,
        });
        result.trust = 'done';
        report.step(`${t.name} — ${s.dryRun ? 'would configure' : 'configured'} trust`);
      } catch (e) {
        report.fail(`${t.name} — trust failed: ${(e as Error).message}`);
        result.trust = 'fail';
      }
    }
  }
  return result;
}

export function summarize(results: TargetResult[]): {
  claimed: number;
  claimSkipped: number;
  trusted: number;
  trustSkipped: number;
  failed: number;
} {
  const count = (sel: (r: TargetResult) => StepStatus, status: StepStatus) =>
    results.filter(r => sel(r) === status).length;
  return {
    claimed: count(r => r.claim, 'done'),
    claimSkipped: count(r => r.claim, 'skip'),
    trusted: count(r => r.trust, 'done'),
    trustSkipped: count(r => r.trust, 'skip'),
    failed: results.filter(r => r.claim === 'fail' || r.trust === 'fail').length,
  };
}
