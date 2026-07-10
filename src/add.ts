import pc from 'picocolors';
import { findWorkspaceRoot, discoverPackages, detectRepo } from './workspace.js';
import { npmAuthCheck, checkNpmVersion } from './npm.js';
import { resolveTargets, processTarget, summarize, validateTrustSettings, buildSettings, applyIgnore, type Reporter } from './core.js';
import { loadConfig } from './config.js';
import { twoFactorDisabledWarning } from './ui.js';
import { runWizard } from './interactive.js';
import { npmArgs, selectorsOf, type Ctx } from './args.js';

/** Non-interactive path: a plan by default, applies with --yes. */
function runPlain(values: Record<string, any>, selectors: string[]): number {
  const root = findWorkspaceRoot();
  const config = loadConfig(root);
  const discovered = applyIgnore(discoverPackages(root), config.ignore);
  const repo = values.repo ?? detectRepo(root)?.slug;

  const resolved = resolveTargets(discovered, selectors, !!values.new, root);
  if (resolved.error) {
    console.error(pc.red(resolved.error));
    return 1;
  }
  if (resolved.targets.length === 0) {
    console.error(pc.red('No public packages found in this workspace.'));
    return 1;
  }

  const dryRun = !values.yes;
  const settings = buildSettings(values, config, repo, dryRun);
  // Trusted publishing only makes sense once a package lives in a repo/CI. A brand-new
  // name isn't necessarily there yet — so if we can't resolve a trust config for an
  // all-new claim, skip trust (with a note) rather than blocking the name claim. Once
  // it's in a repo, `fledgling sync` (or a passed --repo) wires up trust.
  const allNew = resolved.targets.every(t => t.isNew);
  if (!settings.skipTrust && allNew && validateTrustSettings(settings)) {
    console.log(pc.dim('No repo/CI context for a new name — skipping trusted publishing. Run `fledgling sync` once it lives in a repo.'));
    settings.skipTrust = true;
  }
  const trustError = validateTrustSettings(settings);
  if (trustError) {
    console.error(pc.red(trustError));
    return 1;
  }
  // Only the apply path (`--yes`) hits npm. Require login, and warn (don't stop) on a
  // disabled-2FA account so it gets a clear heads-up instead of a raw 403 on first claim.
  if (!dryRun) {
    const auth = npmAuthCheck(settings.registry);
    if (!auth.who) {
      console.error(pc.red('Not logged in to npm. Run `npm login` (with 2FA) and retry.'));
      return 1;
    }
    if (auth.twoFactorDisabled) console.error(twoFactorDisabledWarning);
  }
  // Trusted publishing needs 2FA. Interactively (a TTY), npm prompts for it itself —
  // a browser approval shared across the run. Non-interactively (CI / piped) it can't
  // prompt, so pass --otp; npm surfaces a clear error during the operation otherwise.

  console.log(`${dryRun ? pc.yellow('dry run') : pc.green('apply')} — ${pc.bold('fledgling')} · ${resolved.targets.length} package(s)\n`);
  const reporter: Reporter = {
    step: m => console.log('  ' + pc.green('✓') + ' ' + m),
    skip: m => console.log('  ' + pc.dim('· ' + m)),
    fail: m => console.error('  ' + pc.red('✗') + ' ' + m),
  };
  const sum = summarize(resolved.targets.map(t => processTarget(t, settings, reporter)));

  console.log(
    `\n${dryRun ? pc.yellow('dry run complete') : pc.green('done')} — ` +
      `claimed ${sum.claimed} (skipped ${sum.claimSkipped}), trusted ${sum.trusted} (skipped ${sum.trustSkipped})` +
      (sum.failed ? pc.red(`, failed ${sum.failed}`) : ''),
  );
  if (dryRun) console.log(pc.dim('Re-run with --yes to apply (needs npm login + 2FA).'));
  return sum.failed > 0 ? 1 : 0;
}

/** The create flow (wizard in a TTY, plan/apply otherwise). Shared by the default command and `add`. */
async function createRun(ctx: Ctx): Promise<void> {
  const npmErr = checkNpmVersion();
  if (npmErr) {
    console.error(pc.red(npmErr));
    process.exitCode = 1;
    return;
  }
  const values = ctx.values;
  const selectors = selectorsOf(ctx);
  const interactive = !!process.stdout.isTTY && !values.yes && !values['dry-run'];
  const code = interactive ? await runWizard(values, selectors) : runPlain(values, selectors);
  if (code) process.exitCode = code;
}

/** Default command (`fledgling`, no subcommand) → the interactive wizard. */
export const entryCommand = {
  name: 'fledgling',
  description: 'Claim package names and set up trusted publishing',
  args: npmArgs,
  run: createRun,
};

export const addCommand = {
  name: 'add',
  description: 'Claim names + set up trusted publishing for the given packages',
  args: npmArgs,
  run: createRun,
};
