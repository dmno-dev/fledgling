import * as p from '@clack/prompts';
import pc from 'picocolors';
import { findWorkspaceRoot, discoverPackages, detectRepo, type Pkg } from './workspace.js';
import { npmWhoami, listTrust, configureTrust, revokeTrust, trustReadable } from './npm.js';
import {
  resolveTargets,
  validateTrustSettings,
  buildSettings,
  toTrustOptions,
  trustMatches,
  describeTrustDiff,
} from './core.js';
import { loadConfig } from './config.js';

/**
 * `fledgling sync` — reconcile trusted publishing across the workspace.
 * Authenticates, checks each package's real trust status, shows what's missing,
 * then asks before configuring it.
 */
export async function runSync(values: Record<string, any>, selectors: string[]): Promise<number> {
  console.log();
  p.intro(pc.inverse(pc.cyan(' 🐣 fledgling sync ')));

  const root = findWorkspaceRoot();
  const config = loadConfig(root);
  const repo = values.repo ?? detectRepo(root)?.slug;
  const discovered = discoverPackages(root);

  const resolved = resolveTargets(discovered, selectors, false, root);
  if (resolved.error) {
    p.cancel(pc.red(resolved.error));
    return 1;
  }
  if (!resolved.targets.length) {
    p.cancel(pc.red('No public packages found in this workspace.'));
    return 1;
  }
  const targets = resolved.targets;

  const settings = buildSettings(values, config, repo, false); // apply mode
  settings.skipPublish = true;
  const err = validateTrustSettings(settings);
  if (err) {
    p.cancel(pc.red(err));
    return 1;
  }

  const who = npmWhoami();
  if (!who) {
    p.cancel(pc.red('Not logged in to npm. Run `npm login` and retry.'));
    return 1;
  }
  p.log.info(`Logged in to npm as ${pc.green(who)}`);

  // `npm trust` needs an OTP on 2FA accounts (and it doesn't prompt — it errors).
  // Ask for one if reads aren't working without it.
  let otp = settings.otp;
  if (!trustReadable(targets[0].name, settings.registry, otp)) {
    p.log.warn('npm requires a 2FA one-time password to read and manage trusted publishing.');
    for (let tries = 0; tries < 3; tries++) {
      const code = await p.password({
        message: `npm one-time password (2FA code) for ${who}:`,
        validate: x => (/^\d{6,}$/.test((x ?? '').trim()) ? undefined : 'Enter your 6-digit code'),
      });
      if (p.isCancel(code)) {
        p.cancel('Cancelled.');
        return 1;
      }
      otp = String(code).trim();
      if (trustReadable(targets[0].name, settings.registry, otp)) break;
      p.log.error(pc.red('That code did not work.'));
      if (tries === 2) {
        p.cancel(pc.red('Could not authenticate.'));
        return 1;
      }
    }
  }
  settings.otp = otp;

  p.log.step(`Checking trusted publishing for ${pc.bold(String(targets.length))} package(s)…`);

  type Item = { t: Pkg; status: 'in-sync' | 'drift' | 'missing'; diff?: string[] };
  const items: Item[] = targets.map(t => {
    const entries = listTrust(t.name, settings.registry, otp);
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

  p.note(
    [
      inSync ? pc.dim(`${inSync} in sync`) : '',
      missing.length ? `${pc.yellow(String(missing.length))} not configured:` : '',
      ...missing.map(i => `  ${pc.green('+')} ${i.t.name}`),
      drift.length ? `${pc.yellow(String(drift.length))} out of sync:` : '',
      ...drift.map(i => `  ${pc.yellow('~')} ${i.t.name} ${pc.dim(`(${(i.diff ?? []).join(', ')})`)}`),
    ]
      .filter(Boolean)
      .join('\n'),
    'Trust status',
  );

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

  let failed = 0;
  let fixed = 0;
  for (const i of todo) {
    try {
      if (i.status === 'drift') {
        // npm allows one config per package — revoke the existing one, then re-create
        for (const e of listTrust(i.t.name, settings.registry, otp)) {
          if (e.id) revokeTrust(i.t.name, e.id, settings.registry, otp);
        }
      }
      configureTrust(i.t.name, toTrustOptions(settings));
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
