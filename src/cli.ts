#!/usr/bin/env node
import { cli } from 'gunshi';
import pc from 'picocolors';
import { maybeHandleCompletion } from './completion.js';
import { findWorkspaceRoot, discoverPackages, detectRepo } from './workspace.js';
import { npmWhoami } from './npm.js';
import { resolveTargets, processTarget, summarize, type Settings, type Reporter } from './core.js';
import { runWizard } from './interactive.js';

const VERSION = '0.0.0';

const args = {
  yes: { type: 'boolean', short: 'y', description: 'Apply changes without prompting (default: interactive / dry run)' },
  'dry-run': { type: 'boolean', description: 'Print a plan without prompts (non-interactive)' },
  new: { type: 'boolean', description: 'Treat unmatched names as brand-new packages to claim' },
  'skip-publish': { type: 'boolean', description: 'Only set up trusted publishing' },
  'skip-trust': { type: 'boolean', description: 'Only claim names' },
  provider: { type: 'string', default: 'github', description: 'CI provider: github, gitlab, circleci' },
  repo: { type: 'string', description: 'Trusted-publisher repo (auto-detected from git origin)' },
  workflow: { type: 'string', default: 'release.yml', description: 'Publishing workflow filename' },
  env: { type: 'string', description: 'CI environment for the trusted publisher' },
  'placeholder-version': { type: 'string', default: '0.0.0', description: 'Placeholder version to publish (default 0.0.0)' },
  tag: { type: 'string', description: 'dist-tag for placeholders' },
  otp: { type: 'string', description: 'npm one-time password' },
  'allow-stage-publish': { type: 'boolean', description: 'Also grant staged-publish permission' },
} as const;

function buildSettings(values: Record<string, any>, repo: string | undefined, dryRun: boolean): Settings {
  return {
    dryRun,
    skipPublish: !!values['skip-publish'],
    skipTrust: !!values['skip-trust'],
    provider: (values.provider ?? 'github') as Settings['provider'],
    repo,
    workflow: values.workflow ?? 'release.yml',
    env: values.env,
    version: values['placeholder-version'] ?? '0.0.0',
    tag: values.tag,
    otp: values.otp,
    allowStage: !!values['allow-stage-publish'],
  };
}

/** Non-interactive path: a plan by default, applies with --yes. */
function runPlain(values: Record<string, any>, selectors: string[]): number {
  const root = findWorkspaceRoot();
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

  console.log(`${dryRun ? pc.yellow('dry run') : pc.green('apply')} — ${pc.bold('newdle')} · ${resolved.targets.length} package(s)\n`);
  const reporter: Reporter = {
    step: m => console.log('  ' + pc.green('✓') + ' ' + m),
    skip: m => console.log('  ' + pc.dim('· ' + m)),
    fail: m => console.error('  ' + pc.red('✗') + ' ' + m),
  };
  const settings = buildSettings(values, repo, dryRun);
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

// shell completion (`newdle complete …`) is handled by @bomb.sh/tab, before gunshi
if (maybeHandleCompletion(argv)) {
  process.exit(0);
}

await cli(
  argv,
  {
    name: 'newdle',
    description: 'Create and set up packages on npm with trusted publishing',
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
    name: 'newdle',
    version: VERSION,
    description: 'Create and set up packages on npm with trusted publishing',
  },
);
