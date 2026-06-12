#!/usr/bin/env node
import { cli } from 'gunshi';
import pc from 'picocolors';
import { maybeHandleCompletion } from './completion.js';
import { findWorkspaceRoot, discoverPackages, detectRepo } from './workspace.js';
import { npmWhoami, trustReadable, npmWebLogin } from './npm.js';
import { resolveTargets, processTarget, summarize, validateTrustSettings, buildSettings, type Reporter } from './core.js';
import { loadConfig } from './config.js';
import { runWizard } from './interactive.js';
import { runInit } from './init.js';
import { runSync } from './sync.js';

const VERSION = '0.0.0';

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
  otp: { type: 'string', description: 'npm one-time password' },
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
  const discovered = discoverPackages(root);
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
  if (!dryRun && !npmWhoami()) {
    console.error(pc.red('Not logged in to npm. Run `npm login` (with 2FA) and retry.'));
    return 1;
  }
  // managing trusted publishing needs a web session — log in if we can't read trust
  if (!dryRun && !settings.skipTrust && !trustReadable(resolved.targets[0].name, settings.registry)) {
    console.log(pc.dim('Logging in to npm to manage trusted publishing…'));
    try {
      npmWebLogin(settings.registry);
    } catch {
      console.error(pc.red('npm login failed.'));
      return 1;
    }
  }

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

const rawArgv = process.argv.slice(2);

// `fledgling init` — interactive config setup, written to root package.json
if (rawArgv[0] === 'init') {
  process.exit(await runInit());
}

// shell completion (`fledgling complete …`) is handled by @bomb.sh/tab, before gunshi
if (maybeHandleCompletion(rawArgv)) {
  process.exit(0);
}

// `fledgling sync` — reconcile trusted publishing across every package (trust only)
const isSync = rawArgv[0] === 'sync';
const argv = isSync ? rawArgv.slice(1) : rawArgv;

await cli(
  argv,
  {
    name: 'fledgling',
    description: '🐣 Create and set up packages on npm with trusted publishing',
    args,
    async run(ctx) {
      const selectors = (ctx.positionals ?? []) as string[];
      const values = ctx.values as Record<string, any>;
      if (isSync) {
        const code = await runSync(values, selectors);
        if (code) process.exitCode = code;
        return;
      }
      const interactive = !!process.stdout.isTTY && !values.yes && !values['dry-run'];
      const code = interactive ? await runWizard(values, selectors) : runPlain(values, selectors);
      if (code) process.exitCode = code;
    },
  },
  {
    name: 'fledgling',
    version: VERSION,
    description: '🐣 Create and set up packages on npm with trusted publishing',
  },
);
