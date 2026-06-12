#!/usr/bin/env node
import { cli } from 'gunshi';
import pc from 'picocolors';
import { maybeHandleCompletion } from './completion.js';
import { findWorkspaceRoot, discoverPackages, detectRepo } from './workspace.js';
import { npmWhoami } from './npm.js';
import { resolveTargets, processTarget, summarize, type Settings, type Reporter } from './core.js';
import { loadConfig, type FledglingConfig, type Permission } from './config.js';
import { runWizard } from './interactive.js';
import { runInit } from './init.js';

const VERSION = '0.0.0';

const args = {
  yes: { type: 'boolean', short: 'y', description: 'Apply changes without prompting (default: interactive / dry run)' },
  'dry-run': { type: 'boolean', description: 'Print a plan without prompts (non-interactive)' },
  new: { type: 'boolean', description: 'Treat unmatched names as brand-new packages to claim' },
  'skip-publish': { type: 'boolean', description: 'Only set up trusted publishing' },
  'skip-trust': { type: 'boolean', description: 'Only claim names' },
  // no gunshi defaults on these — so the `fledgling` config can fill them in
  provider: { type: 'string', description: 'CI provider: github (default), gitlab, circleci' },
  repo: { type: 'string', description: 'Trusted-publisher repo (auto-detected from git origin)' },
  workflow: { type: 'string', description: 'Publishing workflow filename (default: release.yml)' },
  env: { type: 'string', description: 'CI environment for the trusted publisher' },
  permissions: { type: 'string', description: 'Permissions to grant: publish (default), stage, both' },
  'placeholder-version': { type: 'string', default: '0.0.0', description: 'Placeholder version to publish' },
  tag: { type: 'string', description: 'dist-tag for placeholders' },
  otp: { type: 'string', description: 'npm one-time password' },
} as const;

/** Resolve a setting with precedence: CLI flag → fledgling config → built-in default. */
function buildSettings(values: Record<string, any>, config: FledglingConfig, repo: string | undefined, dryRun: boolean): Settings {
  return {
    dryRun,
    skipPublish: !!values['skip-publish'],
    skipTrust: !!values['skip-trust'],
    provider: (values.provider ?? config.provider ?? 'github') as Settings['provider'],
    repo,
    workflow: values.workflow ?? config.workflow ?? 'release.yml',
    env: values.env ?? config.environment,
    version: values['placeholder-version'] ?? '0.0.0',
    tag: values.tag,
    otp: values.otp,
    permissions: (values.permissions ?? config.permissions ?? 'publish') as Permission,
  };
}

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
  if (!values['skip-trust'] && !repo) {
    console.error(pc.red('Cannot determine the repo. Pass --repo <owner/repo> (or --skip-trust).'));
    return 1;
  }
  if (!dryRun && !npmWhoami()) {
    console.error(pc.red('Not logged in to npm. Run `npm login` (with 2FA) and retry.'));
    return 1;
  }

  console.log(`${dryRun ? pc.yellow('dry run') : pc.green('apply')} — ${pc.bold('fledgling')} · ${resolved.targets.length} package(s)\n`);
  const reporter: Reporter = {
    step: m => console.log('  ' + pc.green('✓') + ' ' + m),
    skip: m => console.log('  ' + pc.dim('· ' + m)),
    fail: m => console.error('  ' + pc.red('✗') + ' ' + m),
  };
  const settings = buildSettings(values, config, repo, dryRun);
  const sum = summarize(resolved.targets.map(t => processTarget(t, settings, reporter)));

  console.log(
    `\n${dryRun ? pc.yellow('dry run complete') : pc.green('done')} — ` +
      `claimed ${sum.claimed} (skipped ${sum.claimSkipped}), trusted ${sum.trusted} (skipped ${sum.trustSkipped})` +
      (sum.failed ? pc.red(`, failed ${sum.failed}`) : ''),
  );
  if (dryRun) console.log(pc.dim('Re-run with --yes to apply (needs npm login + 2FA).'));
  return sum.failed > 0 ? 1 : 0;
}

const argv = process.argv.slice(2);

// `fledgling init` — interactive config setup, written to root package.json
if (argv[0] === 'init') {
  process.exit(await runInit());
}

// shell completion (`fledgling complete …`) is handled by @bomb.sh/tab, before gunshi
if (maybeHandleCompletion(argv)) {
  process.exit(0);
}

await cli(
  argv,
  {
    name: 'fledgling',
    description: '🐣 Create and set up packages on npm with trusted publishing',
    args,
    async run(ctx) {
      const selectors = (ctx.positionals ?? []) as string[];
      const values = ctx.values as Record<string, any>;
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
