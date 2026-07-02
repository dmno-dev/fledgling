#!/usr/bin/env node
import { cli } from 'gunshi';
import pc from 'picocolors';
import { maybeHandleCompletion } from './completion.js';
import { findWorkspaceRoot, discoverPackages, detectRepo } from './workspace.js';
import { npmWhoami, npmTwoFactorStatus, checkNpmVersion } from './npm.js';
import { resolveTargets, processTarget, summarize, validateTrustSettings, buildSettings, applyIgnore, type Reporter } from './core.js';
import { loadConfig } from './config.js';
import { runWizard } from './interactive.js';
import { runInit } from './init.js';
import { runSync } from './sync.js';

declare const __VERSION__: string;
const VERSION = __VERSION__;

const args = {
  // run options (per invocation)
  yes: { type: 'boolean', short: 'y', description: 'Apply changes without prompting (default: interactive / dry run)' },
  'dry-run': { type: 'boolean', description: 'Print a plan without prompts (non-interactive)' },
  new: { type: 'boolean', description: 'Treat unmatched names as brand-new packages to claim' },
  'skip-publish': { type: 'boolean', description: 'Only set up trusted publishing' },
  'skip-trust': { type: 'boolean', description: 'Only claim names' },
  force: { type: 'boolean', description: 'Replace an existing trusted publisher (revoke + re-create)' },
  'placeholder-version': { type: 'string', default: '0.0.0', description: 'Placeholder version to publish' },
  tag: { type: 'string', description: 'dist-tag for placeholders' },
  otp: { type: 'string', description: 'npm 2FA one-time password (used for every npm call this run)' },
  'otp-secret': { type: 'string', description: 'TOTP secret to generate 2FA codes from (use $FLEDGLING_OTP_SECRET to avoid shell history)' },
  // config — best set once in package.json "fledgling" (run `fledgling init`); flags override.
  // No gunshi defaults here, so config can fill them in.
  provider: { type: 'string', description: '[config] CI provider: github (default), gitlab, circleci' },
  registry: { type: 'string', description: '[config] npm registry URL (default: your npm config)' },
  permissions: { type: 'string', description: '[config] permissions to grant: publish (default), stage, both' },
  repo: { type: 'string', description: '[config][github/gitlab] repo (default: auto-detected from git origin)' },
  workflow: { type: 'string', description: '[config][github/gitlab] publishing workflow filename (default: release.yml)' },
  env: { type: 'string', description: '[config][github/gitlab] CI environment (default: none)' },
  'org-id': { type: 'string', description: '[config][circleci] organization UUID' },
  'project-id': { type: 'string', description: '[config][circleci] project UUID' },
  'pipeline-definition-id': { type: 'string', description: '[config][circleci] pipeline definition UUID' },
  'vcs-origin': { type: 'string', description: '[config][circleci] VCS origin, e.g. github/owner/repo' },
  'context-id': { type: 'string', multiple: true, description: '[config][circleci] context UUID (repeatable)' },
} as const;

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
  const trustError = validateTrustSettings(settings);
  if (trustError) {
    console.error(pc.red(trustError));
    return 1;
  }
  if (!dryRun && !npmWhoami(settings.registry)) {
    console.error(pc.red('Not logged in to npm. Run `npm login` (with 2FA) and retry.'));
    return 1;
  }
  // npm requires 2FA (or a bypass-2FA token) to publish; warn (don't stop) so a disabled
  // account gets a clear heads-up instead of a raw 403 on the first claim.
  if (!dryRun && npmTwoFactorStatus(settings.registry) === 'disabled') {
    console.error(
      pc.yellow(
        "Warning: your npm account doesn't have 2FA enabled — npm requires it to publish, so claims will fail with a 403.\n" +
          'Enable it at https://www.npmjs.com/settings/~/profile (or use a granular access token with "bypass 2FA").',
      ),
    );
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

/**
 * gunshi keeps the matched subcommand name in `positionals` (e.g. `add foo` →
 * `['add','foo']` with `commandPath: ['add']`), so drop the command path to get
 * the real package selectors. The default command has an empty path, so this is a
 * no-op there.
 */
type Ctx = { values: Record<string, any>; positionals?: string[]; commandPath?: string[] };
const selectorsOf = (ctx: Ctx): string[] => (ctx.positionals ?? []).slice(ctx.commandPath?.length ?? 0);

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

// Default command (`fledgling`, no subcommand) → the interactive wizard.
const entry = {
  name: 'fledgling',
  description: 'Claim package names and set up trusted publishing',
  args,
  run: createRun,
};

const addCommand = {
  name: 'add',
  description: 'Claim names + set up trusted publishing for the given packages',
  args,
  run: createRun,
};

const syncCommand = {
  name: 'sync',
  description: 'Reconcile trusted publishing on npm with your config',
  args,
  async run(ctx: Ctx) {
    const npmErr = checkNpmVersion();
    if (npmErr) {
      console.error(pc.red(npmErr));
      process.exitCode = 1;
      return;
    }
    const code = await runSync(ctx.values, selectorsOf(ctx));
    if (code) process.exitCode = code;
  },
};

const initCommand = {
  name: 'init',
  description: 'Write trusted-publishing config to your package.json',
  async run() {
    const code = await runInit();
    if (code) process.exitCode = code;
  },
};

const rawArgv = process.argv.slice(2);

// shell completion (`fledgling complete …`) is handled by @bomb.sh/tab, before gunshi
if (maybeHandleCompletion(rawArgv)) {
  process.exit(0);
}

try {
  await cli(rawArgv, entry, {
    name: 'fledgling',
    version: VERSION,
    description: '🐣 Create and set up packages on npm with trusted publishing',
    subCommands: { add: addCommand, sync: syncCommand, init: initCommand },
    renderHeader: null, // no auto-printed banner on every run
  });
} catch (e) {
  const m = (e as Error).message?.match(/Command not found: (.+)/);
  if (m) {
    console.error(pc.red(`Unknown command '${m[1].trim()}'.`));
    console.error(pc.dim(`To set up a package by name, run: fledgling add ${m[1].trim()}`));
    process.exitCode = 1;
  } else {
    throw e;
  }
}
