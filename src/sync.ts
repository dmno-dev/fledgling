import * as p from '@clack/prompts';
import pc from 'picocolors';
import { findWorkspaceRoot, discoverPackages, detectRepo, type Pkg } from './workspace.js';
import { npmAuthCheck, listTrust, configureTrust, revokeTrust, warmNpmAuth, publishedNames } from './npm.js';
import {
  resolveTargets,
  validateTrustSettings,
  buildSettings,
  toTrustOptions,
  trustMatches,
  describeTrustDiff,
  describeConfig,
  applyIgnore,
} from './core.js';
import { loadConfig } from './config.js';
import { hatchSpinner, hatchIntro, otpBoxReminder, reportNpmAuth, note } from './ui.js';

/**
 * `fledgling sync` — reconcile trusted publishing across the workspace.
 * Authenticates, checks each package's real trust status, shows what's missing,
 * then asks before configuring it.
 */
export async function runSync(values: Record<string, any>, selectors: string[]): Promise<number> {
  console.log();
  await hatchIntro('fledgling sync');

  const root = findWorkspaceRoot();
  const config = loadConfig(root);
  const repo = values.repo ?? detectRepo(root)?.slug;

  // sync reads and writes live trust config, so it needs to be logged in — check up
  // front (per-registry) before any scanning, so we fail fast with a clear message.
  const registry = values.registry ?? config.registry;
  const auth = npmAuthCheck(registry);
  if (!auth.who) {
    p.cancel(pc.red('Not logged in to npm. Run `npm login` (with 2FA) and retry.'));
    return 1;
  }
  // Reports "logged in as…" and warns if 2FA is off (trust writes would 403).
  reportNpmAuth(auth);

  const discovered = applyIgnore(discoverPackages(root), config.ignore);

  const resolved = resolveTargets(discovered, selectors, false, root);
  if (resolved.error) {
    p.cancel(pc.red(resolved.error));
    return 1;
  }
  if (!resolved.targets.length) {
    p.cancel(pc.red('No public packages found in this workspace.'));
    return 1;
  }
  let targets = resolved.targets;

  const settings = buildSettings(values, config, repo, false); // apply mode
  settings.skipPublish = true;
  const err = validateTrustSettings(settings);
  if (err) {
    p.cancel(pc.red(err));
    return 1;
  }

  note(describeConfig(settings), 'Syncing trust settings');

  // trusted publishing can only be configured for packages that exist on npm
  const checkSpin = hatchSpinner();
  checkSpin.start('Checking packages exist on npm…');
  const published = await publishedNames(
    targets.map(t => t.name),
    settings.registry,
  );
  const notYet = targets.length - published.size;
  checkSpin.stop(
    notYet === 0
      ? `All ${targets.length} package(s) exist on npm`
      : `${notYet} of ${targets.length} package(s) not on npm yet`,
  );
  const unpublished = targets.filter(t => !published.has(t.name));
  if (unpublished.length) {
    p.log.warn(
      `${unpublished.length} package(s) aren't on npm yet — run ${pc.bold('fledgling')} to claim them first:\n` +
        unpublished.map(t => `  ${pc.dim('·')} ${t.name}`).join('\n'),
    );
  }
  targets = targets.filter(t => published.has(t.name));
  if (!targets.length) {
    p.outro(pc.yellow('Nothing to sync yet — claim these packages with `fledgling` first.'));
    return 0;
  }

  // Reading and managing trusted publishing needs 2FA. npm does this interactively (a
  // browser approval, cached ~5 min), but our trust *reads* capture stdout to parse
  // their JSON, so they can't surface that prompt themselves. Warm npm's session cache
  // once here with an interactive call, so the reads and writes that follow ride it.
  // (Skipped when --otp / --otp-secret was passed — the non-interactive escape hatch.)
  if (!settings.otp && !settings.otpSecret) {
    p.log.info(otpBoxReminder);
    p.log.step('Authenticating with npm — a browser window may open to approve 2FA…');
    if (!warmNpmAuth(targets[0].name, settings.registry)) {
      p.cancel(pc.red('Could not authenticate with npm.'));
      return 1;
    }
  }

  p.log.step(`Checking trusted publishing for ${pc.bold(String(targets.length))} package(s)…`);

  type Item = { t: Pkg; status: 'in-sync' | 'drift' | 'missing'; diff?: string[] };
  const items: Item[] = targets.map(t => {
    const entries = listTrust(t.name, settings.registry, settings);
    if (!entries.length) return { t, status: 'missing' };
    if (trustMatches(entries[0], settings)) return { t, status: 'in-sync' };
    return { t, status: 'drift', diff: describeTrustDiff(entries[0], settings) };
  });

  const missing = items.filter(i => i.status === 'missing');
  const drift = items.filter(i => i.status === 'drift');
  const inSync = items.filter(i => i.status === 'in-sync').length;
  const todo = [...missing, ...drift];

  if (!todo.length) {
    p.outro(pc.green(`All ${targets.length} package(s) are in sync 🐣`));
    return 0;
  }

  const statusLines: string[] = [];
  if (inSync) statusLines.push(pc.green(`✓ ${inSync} in sync`));
  if (missing.length) {
    statusLines.push(pc.yellow(`${missing.length} not configured:`));
    for (const i of missing) statusLines.push(`  ${pc.green('+')} ${pc.cyan(i.t.name)}`);
  }
  if (drift.length) {
    statusLines.push(pc.yellow(`${drift.length} out of sync:`));
    for (const i of drift) {
      statusLines.push(`  ${pc.yellow('~')} ${pc.cyan(i.t.name)}`);
      for (const change of i.diff ?? []) statusLines.push(`      ${change}`);
    }
  }
  note(statusLines.join('\n'), 'Trust status');

  const apply = values.yes
    ? true
    : await p.confirm({ message: `Fix ${todo.length} package(s) to match your config?`, initialValue: true });
  if (p.isCancel(apply)) {
    p.cancel('Cancelled.');
    return 1;
  }
  if (!apply) {
    p.outro('Nothing changed.');
    return 0;
  }

  // Apply one package's fix. npm prompts for (cached) 2FA itself if its session has
  // lapsed mid-run, so there's no OTP bookkeeping to do here.
  const applyOne = (i: Item): void => {
    if (i.status === 'drift') {
      // npm allows one config per package — revoke the existing one, then re-create
      for (const e of listTrust(i.t.name, settings.registry, settings)) {
        if (e.id) revokeTrust(i.t.name, e.id, settings.registry, settings);
      }
    }
    configureTrust(i.t.name, toTrustOptions(settings));
  };

  let failed = 0;
  let fixed = 0;
  for (const i of todo) {
    try {
      applyOne(i);
      p.log.success(`${i.t.name} — ${i.status === 'drift' ? 'updated' : 'configured'} trust`);
      fixed++;
    } catch (e) {
      p.log.error(`${i.t.name} — failed: ${(e as Error).message}`);
      failed++;
    }
  }
  p.outro(failed ? pc.red(`Done with ${failed} failure(s).`) : pc.green(`Synced ${fixed} package(s) 🐣`));
  return failed > 0 ? 1 : 0;
}
