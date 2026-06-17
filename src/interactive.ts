import * as p from '@clack/prompts';
import pc from 'picocolors';
import { findWorkspaceRoot, discoverPackages, detectRepo, type Pkg } from './workspace.js';
import { npmWhoami, publishedNames, warmNpmAuth } from './npm.js';
import {
  resolveTargets,
  processTarget,
  summarize,
  describeConfig,
  applyIgnore,
  type Settings,
  type Reporter,
  type TargetResult,
  type TrustView,
} from './core.js';
import { loadConfig, type Permission, type Provider } from './config.js';
import { hatchSpinner, hatchIntro, cmd, otpBoxReminder, note } from './ui.js';

const cancelled = (v: unknown): boolean => p.isCancel(v);

/** Interactive walkthrough: scan → pick → configure → confirm → apply. */
export async function runWizard(values: Record<string, any>, selectors: string[]): Promise<number> {
  console.log();
  await hatchIntro('fledgling');

  const root = findWorkspaceRoot();
  const config = loadConfig(root);
  const registry: string | undefined = values.registry ?? config.registry;
  // Claiming explicit `--new` names isn't about the local workspace, so skip the
  // "Found N · repo" framing — but still discover packages (to resolve the names) and
  // detect the repo (used as the trusted-publishing default if you opt in).
  const newClaim = !!values.new;
  const spin = hatchSpinner();
  if (!newClaim) spin.start('Scanning workspace');
  const discovered = applyIgnore(discoverPackages(root), config.ignore);
  const repoInfo = detectRepo(root);
  if (!newClaim) {
    spin.stop(`Found ${pc.bold(String(discovered.length))} package(s)${repoInfo ? ` · ${pc.dim(repoInfo.slug)}` : ''}`);
  } else if (selectors.length) {
    p.log.step(`Claiming new package${selectors.length > 1 ? 's' : ''}: ${selectors.map(s => `📦 ${pc.cyan(s)}`).join(', ')}`);
  }

  // Check login up front (per-registry) so we can flag it before any prompts. We don't
  // hard-stop — without a login we still walk through and show a dry-run preview.
  const who = npmWhoami(registry);
  if (who) p.log.info(`Logged in to npm as ${pc.green(who)}`);
  else p.log.warn(pc.yellow('Not logged in to npm — run `npm login` (with 2FA) to apply. This run will be a dry run.'));

  // --- choose targets ---
  const onlyTrust = !!values['skip-publish'];
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
  }

  // See what's already on npm. Claiming is only for names that don't exist yet — so
  // if everything here is already published there's nothing to claim, and the user
  // probably wants `fledgling sync` to reconcile trusted publishing instead. In
  // `--new` mode the count is redundant (we'll either say it's taken or start claiming),
  // so check quietly there.
  const checkSpin = hatchSpinner();
  if (!newClaim) checkSpin.start('Checking which packages are already on npm…');
  const published = await publishedNames(
    targets.map(t => t.name),
    registry,
  );
  if (!newClaim) {
    checkSpin.stop(
      published.size === 0
        ? `None on npm yet — ${targets.length} to claim`
        : published.size === targets.length
          ? `All ${targets.length} already on npm`
          : `${published.size} of ${targets.length} already on npm`,
    );
  }
  const fresh = targets.filter(t => !published.has(t.name));

  if (!onlyTrust && fresh.length === 0) {
    // If the user explicitly asked to claim brand-new names (`--new`) and they're taken,
    // say so plainly — don't imply they're workspace packages to sync.
    const taken = targets.filter(t => t.isNew);
    if (taken.length) {
      note(
        `${taken.map(t => `📦 ${pc.cyan(t.name)}`).join(', ')} ${taken.length > 1 ? 'are' : 'is'} already taken on npm — ` +
          `can't claim ${taken.length > 1 ? 'those names' : 'that name'}.`,
        '🛑 Name taken',
      );
      return 1;
    }
    note(
      `Everything here is already on npm, so there's nothing to claim.\n` +
        `To reconcile trusted publishing, run ${cmd('fledgling sync')}.`,
      'Nothing to hatch',
    );
    p.outro(pc.green('All set 🐣'));
    return 0;
  }

  // Narrow to what we'll act on. Only multiselect when the set is ambiguous
  // (discovered from the workspace, not explicitly named, and more than one).
  const pick = async (pool: Pkg[], message: string): Promise<Pkg[] | null> => {
    if (pool.length === 1) return pool;
    const picked = await p.multiselect({
      message,
      options: pool.map(t => ({ value: t.name, label: t.name, hint: published.has(t.name) ? 'on npm' : 'new' })),
      initialValues: pool.map(t => t.name),
      required: true,
    });
    if (cancelled(picked)) return null;
    const set = new Set(picked as string[]);
    return pool.filter(t => set.has(t.name));
  };

  if (onlyTrust) {
    // trust-only: publish status isn't the filter — let the user pick from all
    if (selectors.length === 0 && targets.length > 1) {
      const picked = await pick(targets, 'Which packages?');
      if (!picked) return cancel();
      targets = picked;
    }
  } else {
    if (published.size) {
      p.log.info(`${pc.dim(`${published.size} already on npm — hidden. Use`)} ${cmd('fledgling sync')} ${pc.dim('to (re)configure their trust.')}`);
    }
    if (selectors.length === 0 && fresh.length > 1) {
      const picked = await pick(fresh, 'New packages to set up:');
      if (!picked) return cancel();
      targets = picked;
    } else {
      targets = fresh;
    }
  }

  // --- phases / trust settings (flag → config → default) ---
  const skipPublish = onlyTrust;
  let skipTrust = !!values['skip-trust'] || config.trust === false;
  const provider = (values.provider ?? config.provider ?? 'github') as Provider;
  const permissions = (values.permissions ?? config.permissions ?? 'publish') as Permission;
  let repo: string | undefined = values.repo ?? repoInfo?.slug;
  const workflow: string = values.workflow ?? config.workflow ?? 'release.yml';
  const env: string | undefined = values.env ?? config.environment;
  // circleci
  let orgId: string | undefined = values['org-id'] ?? config.orgId;
  let projectId: string | undefined = values['project-id'] ?? config.projectId;
  let pipelineDefinitionId: string | undefined = values['pipeline-definition-id'] ?? config.pipelineDefinitionId;
  let vcsOrigin: string | undefined = values['vcs-origin'] ?? config.vcsOrigin;
  const contextIds: string[] | undefined = values['context-id'] ?? config.contextIds;

  // Only ask about trusted publishing when claiming a bare name (no repo/CI context yet).
  // For packages already in your repo it's the whole point, so set it up by default
  // (opt out with --skip-trust or `"trust": false` in config).
  const nameOnly = targets.every(t => !discovered.includes(t));
  if (!skipTrust && nameOnly) {
    const wantsTrust = await p.confirm({ message: 'Also set up trusted publishing for it?', initialValue: false });
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
  note(
    [
      `${pc.bold(String(targets.length))} package(s): ${targets.map(t => `📦 ${pc.cyan(t.name)}`).join(', ')}`,
      skipPublish ? '' : pc.green('• claim unpublished names on npm'),
      skipTrust ? '' : pc.green('• set up trusted publishing'),
    ]
      .filter(Boolean)
      .join('\n'),
    'Plan',
  );
  if (!skipTrust) {
    const view: TrustView = { provider, permissions, registry, repo, workflow, env, orgId, projectId, pipelineDefinitionId, vcsOrigin, contextIds };
    note(
      `${describeConfig(view)}\n\n${pc.italic(pc.dim('Change these with `fledgling init`'))}`,
      'Trusted publishing settings',
    );
  }

  // `who` was resolved up front; not logged in → dry-run preview only (already warned).
  let apply = false;
  if (who) {
    const ans = await p.confirm({ message: `Apply now as ${pc.green(who)}?`, initialValue: true });
    if (cancelled(ans)) return cancel();
    apply = !!ans;
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
    otpSecret: values['otp-secret'] ?? process.env.FLEDGLING_OTP_SECRET,
  };

  // npm manages 2FA itself — an interactive browser approval, cached ~5 min. When we
  // publish, the claim's `npm publish` warms that cache for the trust write seconds
  // later, so neither re-prompts. When we're only setting up trust (no claim), nothing
  // has authenticated yet and our trust reads can't prompt — so warm the cache once
  // here against an existing package. (Skipped when --otp / --otp-secret was passed.)
  const interactiveAuth = apply && !settings.otp && !settings.otpSecret;
  if (interactiveAuth && (!skipTrust || !skipPublish)) p.log.info(otpBoxReminder);
  if (interactiveAuth && !skipTrust && skipPublish) {
    const existing = targets.find(t => published.has(t.name));
    if (existing) {
      p.log.step('Authenticating with npm — a browser window may open to approve 2FA…');
      if (!warmNpmAuth(existing.name, registry)) {
        p.cancel(pc.red('Could not authenticate with npm.'));
        return 1;
      }
    }
  }

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
