import * as p from '@clack/prompts';
import pc from 'picocolors';
import { findWorkspaceRoot, detectRepo } from '../workspace.js';
import { loadConfig } from '../config.js';
import { hatchSpinner, hatchIntro, cmd, note } from '../ui.js';
import { selectorsOf, type Ctx } from '../args.js';
import {
  pypiClient,
  buildSdist,
  validatePypiName,
  validatePypiVersion,
  normalizePypiName,
  publishingSettingsUrl,
  pendingPublisherUrl,
  pypiErrorReason,
  looksLikeToken,
  AVAILABILITY_CAVEAT,
  PYPI,
  TEST_PYPI,
  type PypiRegistry,
  type NameStatus,
} from '../pypi.js';

/**
 * `fledgling pypi`'s own flags. Names are given explicitly rather than discovered:
 * PyPI packages live in pyproject.toml, which this command deliberately doesn't read
 * (see the module note in pypi.ts) — claiming a name is useful precisely *before*
 * there's a package to discover.
 */
export const pypiArgs = {
  packages: { type: 'positional', multiple: true, required: false, description: 'PyPI package name(s) to claim' },
  yes: { type: 'boolean', short: 'y', description: 'Apply changes without prompting (default: interactive / dry run)' },
  'dry-run': { type: 'boolean', description: 'Print a plan without prompts (non-interactive)' },
  token: { type: 'string', description: 'PyPI API token (default: $PYPI_TOKEN)' },
  'placeholder-version': { type: 'string', default: '0.0.0', description: 'Placeholder version to publish' },
  summary: { type: 'string', description: 'Summary for the placeholder release' },
  test: { type: 'boolean', description: 'Use TestPyPI (test.pypi.org) instead of PyPI' },
  'repository-url': { type: 'string', description: 'Upload endpoint (default: https://upload.pypi.org/legacy/)' },
  'index-url': { type: 'string', description: 'Web/JSON API base for lookups (default: https://pypi.org)' },
  repo: { type: 'string', description: 'Repo for the trusted-publishing checklist (default: auto-detected from git origin)' },
  workflow: { type: 'string', description: 'Publishing workflow filename for the checklist (default: release.yml)' },
  env: { type: 'string', description: 'CI environment for the checklist (default: none)' },
} as const;

const DEFAULT_SUMMARY = 'Name reserved — no release published yet.';

interface Item {
  name: string;
  status: NameStatus;
  claimed?: boolean;
}

/**
 * `fledgling pypi` — claim PyPI names, then hand off trusted publishing.
 *
 * PyPI has no management API for trusted publishers (see pypi.ts), so this command
 * does the half that *can* be automated — uploading a minimal placeholder sdist to
 * lock each name down — and then prints the exact values to paste into PyPI's web
 * form. Idempotent: names already on PyPI are skipped.
 */
export async function runPypi(values: Record<string, any>, names: string[]): Promise<number> {
  console.log();
  await hatchIntro('fledgling pypi');

  if (!names.length) {
    p.cancel(pc.red('Pass the name(s) to claim, e.g. `fledgling pypi my-great-new-idea`.'));
    return 1;
  }

  const root = findWorkspaceRoot();
  const config = loadConfig(root);

  // --- registry: PyPI, TestPyPI, or a custom pair of endpoints ---
  const base = values.test ? TEST_PYPI : PYPI;
  const registry: PypiRegistry = {
    label: values['repository-url'] || values['index-url'] ? 'custom registry' : base.label,
    upload: values['repository-url'] ?? base.upload,
    index: (values['index-url'] ?? base.index).replace(/\/+$/, ''),
  };

  // --- validate names + version up front, before touching the network ---
  const version: string = values['placeholder-version'];
  const versionError = validatePypiVersion(version);
  if (versionError) {
    p.cancel(pc.red(versionError));
    return 1;
  }
  const summary: string = values.summary ?? DEFAULT_SUMMARY;

  const invalid = names.map(n => ({ n, err: validatePypiName(n) })).filter(x => x.err);
  if (invalid.length) {
    for (const { n, err } of invalid) p.log.error(pc.red(`"${n}" — ${err}`));
    p.cancel(pc.red('Fix the name(s) and re-run.'));
    return 1;
  }
  // PyPI indexes by the PEP 503 normalized name, so two spellings of one name are one
  // claim — dedupe before we start uploading the same thing twice.
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const name of names) {
    const key = normalizePypiName(name);
    if (seen.has(key)) {
      p.log.warn(pc.yellow(`"${name}" is the same PyPI project as an earlier name (both normalize to "${key}") — skipping the duplicate.`));
      continue;
    }
    seen.add(key);
    items.push({ name, status: 'unknown' });
  }

  // --- auth: a token applies; without one we can only preview ---
  const token: string | undefined = values.token ?? process.env.PYPI_TOKEN;
  if (token && !looksLikeToken(token)) {
    p.log.warn(pc.yellow("That token doesn't start with `pypi-` — PyPI API tokens do. Uploads will probably 403."));
  }
  if (!token && !values['dry-run']) {
    p.log.warn(
      pc.yellow('PYPI_TOKEN not set — this run will be a dry run.\n') +
        pc.dim(`Create a token at ${registry.index}/manage/account/token/ and re-run. Your account needs a verified email and 2FA.`),
    );
  }

  const client = pypiClient(registry, token);

  // --- what's already claimed? ---
  const spin = hatchSpinner();
  spin.start(`Checking names on ${registry.label}…`);
  await Promise.all(items.map(async it => void (it.status = await client.nameStatus(it.name))));
  const toClaim = items.filter(it => it.status === 'free');
  const taken = items.filter(it => it.status === 'taken');
  const unknown = items.filter(it => it.status === 'unknown');
  spin.stop(
    toClaim.length === 0 && !unknown.length
      ? `All ${items.length} name(s) already on ${registry.label}`
      : `${toClaim.length} of ${items.length} name(s) free to claim`,
  );
  if (unknown.length) {
    p.log.warn(pc.yellow(`Couldn't reach ${registry.label} for: ${unknown.map(it => it.name).join(', ')} — will attempt the claim anyway.`));
  }
  if (taken.length) {
    p.log.info(pc.dim(`Already on ${registry.label}: ${taken.map(it => it.name).join(', ')}`));
  }

  // --- the values you'll need for the (manual) trusted-publishing step ---
  const repoInfo = detectRepo(root);
  const repoSlug: string | undefined = values.repo ?? repoInfo?.slug;
  const workflow: string = values.workflow ?? config.workflow ?? 'release.yml';
  const environment: string | undefined = values.env ?? config.environment;

  // The checklist is the real deliverable, so it always prints — and always *before*
  // clack's outro, which closes the flow's box.
  const checklist = () => printTrustedPublishingSteps(items, registry, repoSlug, repoInfo?.host, workflow, environment);

  const attempts = items.filter(it => it.status !== 'taken');
  if (!attempts.length) {
    checklist();
    p.outro(pc.green(`Nothing to claim — every name is already on ${registry.label}. 🐣`));
    return 0;
  }

  // --- plan + confirm ---
  note(
    [
      `${pc.bold(String(attempts.length))} name(s) to claim on ${pc.bold(registry.label)}:`,
      ...attempts.map(it => `  📦 ${pc.cyan(it.name)}  ${pc.dim(`→ ${normalizePypiName(it.name)} @ ${version}`)}`),
      '',
      pc.dim(`Uploads a minimal placeholder sdist (one PKG-INFO, no code) to lock the name down.`),
      pc.dim(`Trusted publishing itself has no API — you'll get a checklist for it at the end.`),
    ].join('\n'),
    'Plan',
  );
  p.log.warn(pc.yellow(AVAILABILITY_CAVEAT));

  let dryRun = !!values['dry-run'] || !token;
  let apply = !dryRun && !!values.yes;
  if (!dryRun && !values.yes) {
    if (process.stdout.isTTY) {
      const ans = await p.confirm({ message: `Claim ${attempts.length} name(s) on ${registry.label} now?`, initialValue: true });
      if (p.isCancel(ans)) {
        p.cancel('Cancelled.');
        return 1;
      }
      apply = !!ans;
    } else {
      p.log.info(pc.dim('Non-interactive without --yes — dry run only.'));
    }
  }
  dryRun = !apply;

  if (dryRun) {
    for (const it of attempts) p.log.message(`${pc.dim('would claim')}  ${pc.cyan(it.name)}`);
    checklist();
    p.outro(pc.yellow(`Dry run — ${attempts.length} to claim. Re-run with --yes (and PYPI_TOKEN) to apply.`));
    return 0;
  }

  // --- apply ---
  const failures: string[] = [];
  for (const it of attempts) {
    const dist = buildSdist({ name: it.name, version, summary });
    const claimSpin = hatchSpinner();
    claimSpin.start(`Claiming ${it.name}…`);
    const res = await client.upload(dist);
    if (res.ok) {
      it.claimed = true;
      claimSpin.stop(`${pc.green('claimed')} ${pc.cyan(it.name)} ${pc.dim(`@ ${version}`)}`);
    } else {
      claimSpin.stop(pc.red(`${it.name} — claim failed`));
      p.log.error(pypiErrorReason(res));
      failures.push(it.name);
    }
  }

  const claimed = attempts.filter(it => it.claimed).length;
  checklist();
  p.outro(
    failures.length
      ? pc.red(`Done with ${failures.length} failure(s) — claimed ${claimed}.`)
      : pc.green(`Done — claimed ${claimed}. 🐣`),
  );
  return failures.length ? 1 : 0;
}

/**
 * The manual half. PyPI's publisher management is web-only, so the most useful thing
 * fledgling can do is compute every field value and point at the exact page.
 *
 * Which page depends on whether the project exists: a claimed name has a project-level
 * settings page (and no cap), while a name that was never claimed has to go through
 * pending publishers — capped at 3 per account, and *not* a name reservation.
 */
function printTrustedPublishingSteps(
  items: Item[],
  registry: PypiRegistry,
  repoSlug: string | undefined,
  host: 'github' | 'gitlab' | undefined,
  workflow: string,
  environment: string | undefined,
): void {
  const exists = items.filter(it => it.claimed || it.status === 'taken');
  const pending = items.filter(it => !it.claimed && it.status !== 'taken');

  const row = (label: string, value?: string) =>
    `  ${`${label}:`.padEnd(18)} ${value ? pc.cyan(value) : pc.dim('(none)')}`;
  const [owner, repoName] = (repoSlug ?? '').split('/');

  const lines: string[] = [
    `PyPI has ${pc.bold('no API')} for trusted publishers — this part is a web form. Values for this repo:`,
    '',
    row(host === 'gitlab' ? 'Namespace' : 'Owner', owner),
    row(host === 'gitlab' ? 'Project' : 'Repository name', repoName),
    row('Workflow name', workflow),
    row('Environment name', environment),
  ];
  if (!repoSlug) {
    lines.push('', pc.yellow('No git remote detected — pass --repo owner/repo to fill the first two in.'));
  }
  if (host === 'gitlab') {
    lines.push('', pc.dim('Detected a GitLab remote — use the GitLab tab on the PyPI form (the fields differ slightly).'));
  }
  if (exists.length) {
    lines.push('', pc.bold('Claimed / existing projects') + pc.dim(' — one page each, no limit:'));
    for (const it of exists) lines.push(`  ${pc.dim('·')} ${pc.underline(publishingSettingsUrl(registry, it.name))}`);
  }
  if (pending.length) {
    lines.push(
      '',
      pc.bold('Not claimed yet') + pc.dim(' — register these as pending publishers:'),
      `  ${pc.dim('·')} ${pc.underline(pendingPublisherUrl(registry))}  ${pc.dim(`(${pending.map(it => it.name).join(', ')})`)}`,
      pc.dim('  Max 3 pending publishers per account, and a pending publisher does NOT reserve the name.'),
    );
  }
  lines.push(
    '',
    `Then publish from CI with ${pc.bold('permissions: id-token: write')} and ${cmd('pypa/gh-action-pypi-publish')} — no PyPI token in CI.`,
  );

  note(lines.join('\n'), '🔑 Trusted publishing (manual)');
}

export const pypiCommand = {
  name: 'pypi',
  description: 'Claim package names on PyPI + get the trusted-publishing checklist',
  args: pypiArgs,
  async run(ctx: Ctx) {
    const code = await runPypi(ctx.values, selectorsOf(ctx));
    if (code) process.exitCode = code;
  },
};
