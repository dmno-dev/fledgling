import * as p from '@clack/prompts';
import pc from 'picocolors';
import { findWorkspaceRoot, discoverPackages, detectRepo, type Pkg } from './workspace.js';
import { npmWhoami, listTrust, configureTrust } from './npm.js';
import { resolveTargets, validateTrustSettings, buildSettings, toTrustOptions } from './core.js';
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
    p.cancel(pc.red('Not logged in to npm. Run `npm login` (with 2FA) and retry.'));
    return 1;
  }

  // Check trust status. The first list call authenticates (npm OTP/web-auth);
  // later ones reuse it. No spinner here so npm's auth prompt stays readable.
  p.log.step(`Checking trusted publishing for ${pc.bold(String(targets.length))} package(s) as ${pc.green(who)}…`);
  p.log.message(pc.dim('(you may be asked to authenticate)'));
  const needsSetup: Pkg[] = [];
  let configured = 0;
  for (const t of targets) {
    if (listTrust(t.name, settings.registry, true).length) configured++;
    else needsSetup.push(t);
  }

  if (!needsSetup.length) {
    p.outro(pc.green(`All ${targets.length} package(s) already have trusted publishing 🐣`));
    return 0;
  }

  p.note(
    [
      configured ? pc.dim(`${configured} already configured`) : '',
      `${pc.yellow(String(needsSetup.length))} need trusted publishing:`,
      ...needsSetup.map(t => `  ${pc.green('+')} ${t.name}`),
    ]
      .filter(Boolean)
      .join('\n'),
    'Trust status',
  );

  const apply = values.yes
    ? true
    : await p.confirm({ message: `Set up trusted publishing for ${needsSetup.length} package(s)?`, initialValue: true });
  if (p.isCancel(apply)) {
    p.cancel('Cancelled.');
    return 1;
  }
  if (!apply) {
    p.outro('Nothing changed.');
    return 0;
  }

  let failed = 0;
  for (const t of needsSetup) {
    try {
      configureTrust(t.name, toTrustOptions(settings));
      p.log.success(`${t.name} — configured trust`);
    } catch (e) {
      p.log.error(`${t.name} — failed: ${(e as Error).message}`);
      failed++;
    }
  }
  p.outro(
    failed
      ? pc.red(`Done with ${failed} failure(s).`)
      : pc.green(`Configured trust for ${needsSetup.length} package(s) 🐣`),
  );
  return failed > 0 ? 1 : 0;
}
