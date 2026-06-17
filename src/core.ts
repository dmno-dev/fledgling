import pc from 'picocolors';
import type { Pkg } from './workspace.js';
import { discoverPackages, findWorkspaceRoot } from './workspace.js';
import {
  packageExists,
  listTrust,
  revokeTrust,
  publishPlaceholder,
  configureTrust,
  type TrustOptions,
  type TrustEntry,
} from './npm.js';
import { loadConfig, type Permission, type Provider, type FledglingConfig } from './config.js';

export interface Settings {
  dryRun: boolean;
  skipPublish: boolean;
  skipTrust: boolean;
  force: boolean;
  version: string;
  tag?: string;
  otp?: string;
  otpSecret?: string;
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
    skipTrust: !!values['skip-trust'] || config.trust === false,
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
    otpSecret: values['otp-secret'] ?? process.env.FLEDGLING_OTP_SECRET,
  };
}

export function toTrustOptions(s: Settings): TrustOptions {
  return {
    provider: s.provider,
    permissions: s.permissions,
    registry: s.registry,
    otp: s.otp,
    otpSecret: s.otpSecret,
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

// --- drift detection: compare an existing remote config to the desired settings ---

const PERMS: Record<Permission, string[]> = {
  publish: ['createPackage'],
  stage: ['createStagedPackage'],
  both: ['createPackage', 'createStagedPackage'],
};
const eq = (a: string | undefined, b: string | undefined) => (a || undefined) === (b || undefined);
const sameList = (a: string[] | undefined, b: string[] | undefined) =>
  [...(a ?? [])].sort().join(',') === [...(b ?? [])].sort().join(',');

/** Does an existing trusted-publisher config match the desired settings? */
export function trustMatches(e: TrustEntry, s: Settings): boolean {
  if (e.type !== s.provider) return false;
  if (!sameList(e.permissions, PERMS[s.permissions])) return false;
  if (s.provider === 'circleci') {
    return (
      eq(e.orgId, s.orgId) &&
      eq(e.projectId, s.projectId) &&
      eq(e.pipelineDefinitionId, s.pipelineDefinitionId) &&
      eq(e.vcsOrigin, s.vcsOrigin) &&
      sameList(e.contextIds, s.contextIds)
    );
  }
  const entity = s.provider === 'gitlab' ? e.project : e.repository;
  return eq(entity, s.repo) && eq(e.file, s.workflow) && eq(e.environment, s.env);
}

/** Colorized "current → desired" list of what differs (one entry per changed field). */
export function describeTrustDiff(e: TrustEntry, s: Settings): string[] {
  // quote real values (so empties/whitespace are obvious), dim a bare (none)
  const fmt = (v: string | undefined, color: (s: string) => string) =>
    v ? color(`"${v}"`) : pc.dim('(none)');
  const delta = (key: string, from?: string, to?: string) =>
    `${pc.dim(key)} ${fmt(from, pc.red)} ${pc.dim('→')} ${fmt(to, pc.green)}`;
  const d: string[] = [];
  if (e.type !== s.provider) d.push(delta('provider', e.type, s.provider));
  if (!sameList(e.permissions, PERMS[s.permissions])) {
    d.push(delta('permissions', (e.permissions ?? []).join('+'), s.permissions));
  }
  if (s.provider === 'circleci') {
    if (!eq(e.orgId, s.orgId)) d.push(delta('org-id', e.orgId, s.orgId));
    if (!eq(e.projectId, s.projectId)) d.push(delta('project-id', e.projectId, s.projectId));
    if (!eq(e.pipelineDefinitionId, s.pipelineDefinitionId)) d.push(delta('pipeline-id', e.pipelineDefinitionId, s.pipelineDefinitionId));
    if (!eq(e.vcsOrigin, s.vcsOrigin)) d.push(delta('vcs-origin', e.vcsOrigin, s.vcsOrigin));
    if (!sameList(e.contextIds, s.contextIds)) d.push(`${pc.dim('context-ids')} ${pc.yellow('differ')}`);
  } else {
    const entity = s.provider === 'gitlab' ? e.project : e.repository;
    if (!eq(entity, s.repo)) d.push(delta('repo', entity, s.repo));
    if (!eq(e.file, s.workflow)) d.push(delta('workflow', e.file, s.workflow));
    if (!eq(e.environment, s.env)) d.push(delta('environment', e.environment, s.env));
  }
  return d;
}

export type TrustView = Pick<
  Settings,
  'provider' | 'permissions' | 'registry' | 'repo' | 'workflow' | 'env' | 'orgId' | 'projectId' | 'pipelineDefinitionId' | 'vcsOrigin' | 'contextIds'
>;

/** The desired trusted-publishing config, formatted for display. */
export function describeConfig(c: TrustView): string {
  const v = (val?: string) => (val ? pc.cyan(val) : pc.dim('(none)'));
  const row = (label: string, val?: string) => `${`${label}:`.padEnd(12)} ${v(val)}`;
  const lines = [row('provider', c.provider), row('permissions', c.permissions)];
  if (c.provider === 'circleci') {
    lines.push(
      row('org-id', c.orgId),
      row('project-id', c.projectId),
      row('pipeline-id', c.pipelineDefinitionId),
      row('vcs-origin', c.vcsOrigin),
    );
    if (c.contextIds?.length) lines.push(row('context-ids', c.contextIds.join(', ')));
  } else {
    lines.push(row('repo', c.repo), row('workflow', c.workflow), row('environment', c.env));
  }
  if (c.registry) lines.push(row('registry', c.registry));
  return lines.join('\n');
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

/** Drop packages whose name matches an `ignore` glob (from `fledgling.ignore`). */
export function applyIgnore(pkgs: Pkg[], ignore?: string[]): Pkg[] {
  if (!ignore?.length) return pkgs;
  const res = ignore.map(globToRegExp);
  return pkgs.filter(p => !res.some(re => re.test(p.name)));
}

/** Package names in the current workspace — used for tab completion and the wizard. */
export function workspacePackages(): Pkg[] {
  const root = findWorkspaceRoot();
  return applyIgnore(discoverPackages(root), loadConfig(root).ignore);
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
        matches.push({ name: sel, dir: root, manifest: { name: sel }, isNew: true });
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
  const existedBefore = exists; // a name we're claiming this run has no trust config yet

  // A `--new` name that's already on npm can't be claimed — and we must not configure
  // trust on it against the current repo (you may not own it). Stop with a clear note.
  if (t.isNew && exists) {
    report.fail(`${t.name} — already taken on npm; can't claim this name`);
    result.claim = 'fail';
    return result;
  }

  if (!s.skipPublish) {
    if (exists) {
      report.skip(`${t.name} — name already on npm`);
      result.claim = 'skip';
    } else {
      try {
        publishPlaceholder(placeholderManifest(t, s.version), {
          dryRun: s.dryRun,
          otp: s.otp,
          otpSecret: s.otpSecret,
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
      // Only packages that already existed can have a trust config — a name we just
      // claimed starts empty, so skip the read (which needs npm's warmed 2FA) for it.
      // The write below relies on npm's own interactive 2FA; dry-run is best-effort.
      const existing = existedBefore ? listTrust(t.name, s.registry, s) : [];
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
            for (const e of existing) if (e.id) revokeTrust(t.name, e.id, s.registry, s);
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
