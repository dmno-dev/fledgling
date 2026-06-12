import type { Pkg } from './workspace.js';
import { discoverPackages, findWorkspaceRoot } from './workspace.js';
import { packageExists, listTrust, revokeTrust, publishPlaceholder, configureTrust, type TrustOptions } from './npm.js';
import type { Permission, Provider, FledglingConfig } from './config.js';

export interface Settings {
  dryRun: boolean;
  skipPublish: boolean;
  skipTrust: boolean;
  force: boolean;
  version: string;
  tag?: string;
  otp?: string;
  provider: Provider;
  permissions: Permission;
  registry?: string;
  // github / gitlab
  repo?: string;
  workflow: string;
  env?: string;
  // circleci
  orgId?: string;
  projectId?: string;
  pipelineDefinitionId?: string;
  vcsOrigin?: string;
  contextIds?: string[];
}

/** Validate provider-specific trust requirements. Returns an error message or null. */
export function validateTrustSettings(s: Settings): string | null {
  if (s.skipTrust) return null;
  if (s.provider === 'circleci') {
    const missing = ([
      ['org-id', s.orgId],
      ['project-id', s.projectId],
      ['pipeline-definition-id', s.pipelineDefinitionId],
      ['vcs-origin', s.vcsOrigin],
    ] as const)
      .filter(([, v]) => !v)
      .map(([k]) => `--${k}`);
    if (missing.length) {
      return `CircleCI needs ${missing.join(', ')} (set them via \`fledgling init\` or flags, or use --skip-trust).`;
    }
    return null;
  }
  if (!s.repo) return 'Cannot determine the repo. Pass --repo <owner/repo> (or --skip-trust).';
  return null;
}

/** Resolve a setting with precedence: CLI flag → fledgling config → built-in default. */
export function buildSettings(
  values: Record<string, any>,
  config: FledglingConfig,
  repo: string | undefined,
  dryRun: boolean,
): Settings {
  return {
    dryRun,
    skipPublish: !!values['skip-publish'],
    skipTrust: !!values['skip-trust'],
    force: !!values.force,
    provider: (values.provider ?? config.provider ?? 'github') as Provider,
    permissions: (values.permissions ?? config.permissions ?? 'publish') as Permission,
    registry: values.registry ?? config.registry,
    repo,
    workflow: values.workflow ?? config.workflow ?? 'release.yml',
    env: values.env ?? config.environment,
    orgId: values['org-id'] ?? config.orgId,
    projectId: values['project-id'] ?? config.projectId,
    pipelineDefinitionId: values['pipeline-definition-id'] ?? config.pipelineDefinitionId,
    vcsOrigin: values['vcs-origin'] ?? config.vcsOrigin,
    contextIds: values['context-id'] ?? config.contextIds,
    version: values['placeholder-version'] ?? '0.0.0',
    tag: values.tag,
    otp: values.otp,
  };
}

export function toTrustOptions(s: Settings): TrustOptions {
  return {
    provider: s.provider,
    permissions: s.permissions,
    registry: s.registry,
    dryRun: s.dryRun,
    repo: s.repo,
    workflow: s.workflow,
    env: s.env,
    orgId: s.orgId,
    projectId: s.projectId,
    pipelineDefinitionId: s.pipelineDefinitionId,
    vcsOrigin: s.vcsOrigin,
    contextIds: s.contextIds,
  };
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
    if (isNew) return { targets: [], error: '--new requires a package name, e.g. `fledgling @scope/thing --new`' };
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
  let exists = packageExists(t.name, s.registry);

  if (!s.skipPublish) {
    if (exists) {
      report.skip(`${t.name} — name already on npm`);
      result.claim = 'skip';
    } else {
      try {
        publishPlaceholder(placeholderManifest(t, s.version), {
          dryRun: s.dryRun,
          otp: s.otp,
          tag: s.tag,
          registry: s.registry,
        });
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
    } else {
      // Needs an authenticated session (ensured upstream); dry-run is best-effort.
      const existing = listTrust(t.name, s.registry);
      if (existing.length && !s.force) {
        report.skip(`${t.name} — trust already configured (use --force to replace)`);
        result.trust = 'skip';
      } else if (s.dryRun) {
        // dry-run can't authenticate to check, so it can't see an existing config
        report.step(
          s.force
            ? `${t.name} — would replace trust`
            : `${t.name} — would set up trust (if not already configured)`,
        );
        result.trust = 'done';
      } else {
        try {
          // npm allows one config per package — revoke the existing one before replacing
          if (s.force && existing.length) {
            for (const e of existing) if (e.id) revokeTrust(t.name, e.id, s.registry);
          }
          configureTrust(t.name, toTrustOptions(s));
          result.trust = 'done';
          report.step(`${t.name} — ${s.force && existing.length ? 'replaced' : 'configured'} trust`);
        } catch (e) {
          report.fail(`${t.name} — trust failed: ${(e as Error).message}`);
          result.trust = 'fail';
        }
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
