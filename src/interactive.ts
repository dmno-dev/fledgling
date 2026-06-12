import * as p from '@clack/prompts';
import pc from 'picocolors';
import { findWorkspaceRoot, discoverPackages, detectRepo, type Pkg } from './workspace.js';
import { npmWhoami } from './npm.js';
import {
  resolveTargets,
  processTarget,
  summarize,
  type Settings,
  type Reporter,
  type TargetResult,
} from './core.js';
import { loadConfig, type Permission, type Provider } from './config.js';

const cancelled = (v: unknown): boolean => p.isCancel(v);

/** Interactive walkthrough: scan → pick → configure → confirm → apply. */
export async function runWizard(values: Record<string, any>, selectors: string[]): Promise<number> {
  console.log();
  p.intro(pc.inverse(pc.cyan(' 🐣 fledgling ')));

  const root = findWorkspaceRoot();
  const config = loadConfig(root);
  const spin = p.spinner();
  spin.start('Scanning workspace');
  const discovered = discoverPackages(root);
  const repoInfo = detectRepo(root);
  spin.stop(`Found ${pc.bold(String(discovered.length))} package(s)${repoInfo ? ` · ${pc.dim(repoInfo.slug)}` : ''}`);

  // --- choose targets ---
  let targets: Pkg[];
  if (discovered.length === 0 && selectors.length === 0) {
    const name = await p.text({
      message: 'No packages found here. Name one to claim:',
      placeholder: '@scope/my-package',
      validate: v => (v?.trim() ? undefined : 'Enter a package name'),
    });
    if (cancelled(name)) return cancel();
    targets = [{ name: String(name).trim(), dir: root, manifest: { name: String(name).trim() } }];
  } else {
    const resolved = resolveTargets(discovered, selectors, !!values.new, root);
    if (resolved.error) {
      p.cancel(pc.red(resolved.error));
      return 1;
    }
    targets = resolved.targets;
    if (selectors.length === 0 && targets.length > 1) {
      const picked = await p.multiselect({
        message: 'Which packages?',
        options: targets.map(t => ({ value: t.name, label: t.name })),
        initialValues: targets.map(t => t.name),
        required: true,
      });
      if (cancelled(picked)) return cancel();
      const set = new Set(picked as string[]);
      targets = targets.filter(t => set.has(t.name));
    }
  }

  // --- phases / trust settings (flag → config → default) ---
  const skipPublish = !!values['skip-publish'];
  let skipTrust = !!values['skip-trust'];
  const provider = (values.provider ?? config.provider ?? 'github') as Provider;
  const permissions = (values.permissions ?? config.permissions ?? 'publish') as Permission;
  const registry: string | undefined = values.registry ?? config.registry;
  let repo: string | undefined = values.repo ?? repoInfo?.slug;
  const workflow: string = values.workflow ?? config.workflow ?? 'release.yml';
  const env: string | undefined = values.env ?? config.environment;
  // circleci
  let orgId: string | undefined = values['org-id'] ?? config.orgId;
  let projectId: string | undefined = values['project-id'] ?? config.projectId;
  let pipelineDefinitionId: string | undefined = values['pipeline-definition-id'] ?? config.pipelineDefinitionId;
  let vcsOrigin: string | undefined = values['vcs-origin'] ?? config.vcsOrigin;
  const contextIds: string[] | undefined = values['context-id'] ?? config.contextIds;

  if (!skipTrust) {
    const wantsTrust = await p.confirm({ message: 'Set up trusted publishing (OIDC)?', initialValue: true });
    if (cancelled(wantsTrust)) return cancel();
    skipTrust = !wantsTrust;
  }
  if (!skipTrust && provider !== 'circleci' && !repo) {
    const r = await p.text({
      message: 'Repo for the trusted publisher (owner/repo):',
      placeholder: 'me/my-repo',
      validate: v => (/^[^/]+\/[^/]+$/.test((v ?? '').trim()) ? undefined : 'Use owner/repo'),
    });
    if (cancelled(r)) return cancel();
    repo = String(r).trim();
  }
  if (!skipTrust && provider === 'circleci') {
    const fields: [string, () => string | undefined, (v: string) => void][] = [
      ['CircleCI org id', () => orgId, v => (orgId = v)],
      ['CircleCI project id', () => projectId, v => (projectId = v)],
      ['CircleCI pipeline definition id', () => pipelineDefinitionId, v => (pipelineDefinitionId = v)],
      ['CircleCI VCS origin (e.g. github/owner/repo)', () => vcsOrigin, v => (vcsOrigin = v)],
    ];
    for (const [label, get, set] of fields) {
      if (get()) continue;
      const v = await p.text({ message: `${label}:`, validate: x => (x?.trim() ? undefined : 'Required') });
      if (cancelled(v)) return cancel();
      set(String(v).trim());
    }
  }

  // --- plan + confirm ---
  const trustLine =
    provider === 'circleci'
      ? `• circleci trusted publishing → ${vcsOrigin} · ${permissions}`
      : `• ${provider} trusted publishing → ${repo} · ${workflow}${env ? ` · env ${env}` : ''} · ${permissions}`;
  p.note(
    [
      `${pc.bold(String(targets.length))} package(s): ${pc.dim(targets.map(t => t.name).join(', '))}`,
      skipPublish ? '' : pc.green('• claim unpublished names on npm'),
      skipTrust ? '' : pc.green(trustLine),
      skipTrust ? '' : pc.dim('  (configure these defaults with `fledgling init`)'),
    ]
      .filter(Boolean)
      .join('\n'),
    'Plan',
  );

  const who = npmWhoami();
  let apply = false;
  if (who) {
    const ans = await p.confirm({ message: `Apply now as ${pc.green(who)}?`, initialValue: true });
    if (cancelled(ans)) return cancel();
    apply = !!ans;
  } else {
    p.log.warn(pc.yellow('Not logged in to npm — applying needs `npm login` (with 2FA). Showing a dry run.'));
  }

  const settings: Settings = {
    dryRun: !apply,
    skipPublish,
    skipTrust,
    force: !!values.force,
    provider,
    permissions,
    registry,
    repo,
    workflow,
    env,
    orgId,
    projectId,
    pipelineDefinitionId,
    vcsOrigin,
    contextIds,
    version: values['placeholder-version'] ?? '0.0.0',
    tag: values.tag,
    otp: values.otp,
  };

  const reporter: Reporter = {
    step: m => p.log.success(m),
    skip: m => p.log.message(pc.dim(m)),
    fail: m => p.log.error(m),
  };

  const results: TargetResult[] = targets.map(t => processTarget(t, settings, reporter));
  const sum = summarize(results);

  p.outro(
    settings.dryRun
      ? pc.yellow(`Dry run — ${sum.claimed} to claim, ${sum.trusted} to trust. Re-run to apply.`)
      : sum.failed
        ? pc.red(`Done with ${sum.failed} failure(s) — claimed ${sum.claimed}, trusted ${sum.trusted}.`)
        : pc.green(`Done — claimed ${sum.claimed}, trusted ${sum.trusted}. 🐣`),
  );
  return sum.failed > 0 ? 1 : 0;
}

function cancel(): number {
  p.cancel('Cancelled.');
  return 1;
}
