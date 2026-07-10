import * as p from '@clack/prompts';
import pc from 'picocolors';
import { setTimeout as sleep } from 'node:timers/promises';
import { findWorkspaceRoot, discoverPackages, detectRepo, type Pkg } from './workspace.js';
import { resolveTargets, applyIgnore } from './core.js';
import { loadConfig } from './config.js';
import { hatchSpinner, hatchIntro, cmd, note } from './ui.js';
import { selectorsOf, type Ctx } from './args.js';
import {
  jsrClient,
  resolveJsrName,
  ensureJsrManifest,
  isWeeklyLimit,
  jsrErrorReason,
  normalizeDescription,
  runtimeCompatDiffers,
  describeRuntimeCompat,
  JSR_COOLDOWN_MS,
  type JsrName,
  type JsrPackageMeta,
  type RuntimeCompat,
} from './jsr.js';

/** `fledgling jsr`'s own flags — JSR needs none of the npm-shaped `args` in cli.ts
 * (no npm CLI, no OTP, no provider/workflow/environment config). */
export const jsrArgs = {
  yes: { type: 'boolean', short: 'y', description: 'Apply changes without prompting (default: interactive / dry run)' },
  'dry-run': { type: 'boolean', description: 'Print a plan without prompts (non-interactive)' },
  scope: { type: 'string', description: '[config] JSR scope for packages whose npm name has none (or to override it)' },
  repo: { type: 'string', description: 'GitHub repo to link for OIDC publishing (default: auto-detected from git origin)' },
  token: { type: 'string', description: 'JSR personal access token, FULL access (default: $JSR_TOKEN)' },
  'skip-manifest': { type: 'boolean', description: "Don't scaffold missing jsr.json manifests" },
  'skip-link': { type: 'boolean', description: "Only claim names — don't link the GitHub repo" },
  'skip-metadata': { type: 'boolean', description: "Don't sync score metadata (description / runtime compat) to JSR" },
} as const;

interface Item {
  pkg: Pkg;
  jsr: JsrName;
  exists?: boolean;
  needsManifest?: boolean;
  current?: JsrPackageMeta;
  /** A description to push (present only when it differs from what's on JSR). */
  descDrift?: string;
  /** Runtime-compat flags to push (present only when they differ from JSR). */
  rcDrift?: RuntimeCompat;
}

/**
 * `fledgling jsr` — the JSR analogue of the main flow: create ("claim") each package
 * on jsr.io up front (JSR has no create-on-first-publish), scaffold missing jsr.json
 * manifests, and link the GitHub repo so CI publishes token-lessly via OIDC.
 * Idempotent: claimed packages are skipped and the repo link is re-asserted.
 */
export async function runJsr(values: Record<string, any>, selectors: string[]): Promise<number> {
  console.log();
  await hatchIntro('fledgling jsr');

  const root = findWorkspaceRoot();
  const config = loadConfig(root);

  const spin = hatchSpinner();
  spin.start('Scanning workspace');
  const discovered = applyIgnore(discoverPackages(root), config.ignore);
  const repoInfo = detectRepo(root);
  spin.stop(`Found ${pc.bold(String(discovered.length))} package(s)${repoInfo ? ` · ${pc.dim(repoInfo.slug)}` : ''}`);

  const resolved = resolveTargets(discovered, selectors, false, root);
  if (resolved.error) {
    p.cancel(pc.red(resolved.error));
    return 1;
  }
  if (!resolved.targets.length) {
    p.cancel(pc.red('No public packages found in this workspace.'));
    return 1;
  }

  // --- map workspace packages to JSR names (manifest → --scope/config → npm scope) ---
  const scope: string | undefined = values.scope ?? config.jsr?.scope;
  const items: Item[] = [];
  for (const pkg of resolved.targets) {
    const { jsr, error } = resolveJsrName(pkg, scope);
    if (jsr) items.push({ pkg, jsr });
    else p.log.warn(pc.yellow(error!));
  }
  if (!items.length) {
    p.cancel(pc.red('No packages could be mapped to a JSR name.'));
    return 1;
  }

  // --- the GitHub repo to link (JSR's OIDC is the repo link, and GitHub-only) ---
  let repoSlug: string | undefined = values.repo;
  if (repoSlug && !/^[^/]+\/[^/]+$/.test(repoSlug)) {
    p.cancel(pc.red(`--repo should be owner/repo, got "${repoSlug}"`));
    return 1;
  }
  if (!repoSlug && repoInfo) {
    if (repoInfo.host === 'github') repoSlug = repoInfo.slug;
    else p.log.warn(pc.yellow(`JSR's OIDC publishing is GitHub-only — can't link ${repoInfo.slug} (${repoInfo.host}).`));
  }
  const skipLink = !!values['skip-link'] || !repoSlug;
  if (skipLink && !values['skip-link']) {
    p.log.warn(pc.yellow('No GitHub repo to link — claiming names only. Re-run `fledgling jsr` from the repo to enable OIDC publishing.'));
  }

  // --- auth + mode: a full-access token applies; without one we can only preview ---
  const token: string | undefined = values.token ?? process.env.JSR_TOKEN;
  const client = jsrClient(token, wait => p.log.message(pc.dim(`JSR rate limit — waiting ${Math.round(wait / 1000)}s…`)));
  let who: string | null = null;
  if (token) {
    const authSpin = hatchSpinner();
    authSpin.start('Checking JSR token…');
    who = await client.whoami();
    authSpin.stop(
      who
        ? `JSR token OK — authenticated as ${pc.green(who)}`
        : pc.yellow('JSR token did not authenticate (invalid or expired?)'),
    );
  }
  let dryRun = !!values['dry-run'] || !who;
  if (!token && !values['dry-run']) {
    p.log.warn(
      pc.yellow('JSR_TOKEN not set — this run will be a dry run.\n') +
        pc.dim('Create a FULL-access token (jsr.io → Account → Tokens; "package publish" scope is not enough) and re-run.'),
    );
  }

  // --- what's already claimed, and what metadata does it carry? (public reads) ---
  const existsSpin = hatchSpinner();
  existsSpin.start('Checking which packages exist on JSR…');
  for (const it of items) {
    it.current = (await client.getPackage(it.jsr)) ?? undefined;
    it.exists = it.current !== undefined;
  }
  const toClaim = items.filter(it => !it.exists);
  existsSpin.stop(
    toClaim.length === 0
      ? `All ${items.length} package(s) already on JSR`
      : `${items.length - toClaim.length} of ${items.length} already on JSR — ${toClaim.length} to claim`,
  );

  const skipManifest = !!values['skip-manifest'] || config.jsr?.manifest === false;
  if (!skipManifest) {
    for (const it of items) it.needsManifest = ensureJsrManifest(it.pkg, it.jsr, true).action === 'created';
  }
  const manifestCount = items.filter(it => it.needsManifest).length;

  // --- metadata drift (description from package.json, runtimeCompat from config) ---
  // JSR scores packages on this metadata, and it lives only on jsr.io — the jsr.json
  // manifest has no description field, so it can't ride along at publish time. We
  // reconcile it here (the tool already holds the full-access token). A newly-claimed
  // package starts blank, so its whole desired metadata reads as drift.
  const skipMetadata = !!values['skip-metadata'] || config.jsr?.metadata === false;
  if (!skipMetadata) {
    for (const it of items) {
      const desc = normalizeDescription(it.pkg.manifest.description);
      if (desc) {
        if (desc.truncated) p.log.warn(pc.yellow(`${it.jsr.full} — description exceeds 250 chars; truncating for JSR.`));
        if (desc.value !== (it.current?.description ?? '')) it.descDrift = desc.value;
      }
      const desiredRc: RuntimeCompat | undefined = it.pkg.manifest.fledgling?.jsr?.runtimeCompat ?? config.jsr?.runtimeCompat;
      if (desiredRc && runtimeCompatDiffers(it.current?.runtimeCompat, desiredRc)) it.rcDrift = desiredRc;
    }
  }
  const metaCount = items.filter(it => it.descDrift || it.rcDrift).length;

  if (!toClaim.length && skipLink && !manifestCount && !metaCount) {
    p.outro(pc.green('Nothing to do — everything is already on JSR. 🐣'));
    return 0;
  }

  // --- plan + confirm ---
  note(
    [
      `${pc.bold(String(items.length))} package(s): ${items.map(it => `📦 ${pc.cyan(it.jsr.full)}`).join(', ')}`,
      manifestCount ? pc.green(`• scaffold ${manifestCount} missing jsr.json manifest(s)`) : '',
      toClaim.length ? pc.green(`• claim ${toClaim.length} unclaimed name(s) on jsr.io`) : '',
      skipLink ? pc.dim('• repo linking skipped') : pc.green(`• link ${repoSlug} for token-less OIDC publishing`),
      metaCount ? pc.green(`• sync score metadata (description / runtime compat) on ${metaCount} package(s)`) : '',
    ]
      .filter(Boolean)
      .join('\n'),
    'Plan',
  );

  let apply = !dryRun && !!values.yes;
  if (!dryRun && !values.yes) {
    if (process.stdout.isTTY) {
      const ans = await p.confirm({ message: `Apply now as ${pc.green(who!)}?`, initialValue: true });
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
    for (const it of items) {
      const actions = [
        it.needsManifest ? 'scaffold jsr.json' : '',
        it.exists ? '' : 'claim',
        skipLink ? '' : 'link repo',
        it.descDrift ? 'set description' : '',
        it.rcDrift ? `set runtimes (${describeRuntimeCompat(it.rcDrift)})` : '',
      ].filter(Boolean);
      if (actions.length) p.log.message(`${pc.dim('would')} ${actions.join(' + ')}  ${pc.cyan(it.jsr.full)}`);
      else p.log.message(pc.dim(`nothing to do  ${it.jsr.full}`));
    }
    p.outro(pc.yellow(`Dry run — ${toClaim.length} to claim. Re-run with --yes (and JSR_TOKEN) to apply.`));
    return 0;
  }

  // --- preflight: the token must be able to manage every target scope ---
  for (const s of [...new Set(items.map(it => it.jsr.scope))]) {
    const access = await client.scopeAccess(s);
    if (access !== 'ok') {
      p.cancel(
        pc.red(
          access === 'bad-token'
            ? 'The JSR token is invalid or expired.'
            : `This token can't manage @${s} — use a FULL-access token for a scope you're a member of (jsr.io → Account → Tokens).`,
        ),
      );
      return 1;
    }
  }

  // --- apply: scaffold, claim, link, metadata — stopping cleanly at JSR's weekly quota ---
  let claimed = 0;
  let linked = 0;
  let metaSynced = 0;
  const failures: string[] = [];
  let blockedFrom = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      if (it.needsManifest) {
        const m = ensureJsrManifest(it.pkg, it.jsr, false);
        if (m.entryExists === false) {
          p.log.warn(pc.yellow(`${it.jsr.full} — scaffolded jsr.json points at ${m.entry}, which doesn't exist yet. Edit it before publishing.`));
        }
      }
      let didClaim = false;
      if (!it.exists) {
        const r = await client.createPackage(it.jsr);
        if (isWeeklyLimit(r)) {
          blockedFrom = i;
          break;
        }
        if (!r.ok) throw new Error(`claim failed — ${jsrErrorReason(r)}`);
        claimed++;
        didClaim = true;
      }
      let didLink = false;
      if (!skipLink) {
        const [owner, repoName] = repoSlug!.split('/');
        const l = await client.linkRepo(it.jsr, owner, repoName);
        if (!l.ok) throw new Error(`repo link failed — ${jsrErrorReason(l)}`);
        linked++;
        didLink = true;
      }
      // Metadata is a separate PATCH per field (JSR's updatePackage body is a oneOf).
      // The package exists by now (just claimed or pre-existing), so these can't 404.
      const metaBits: string[] = [];
      if (it.descDrift !== undefined) {
        const r = await client.setDescription(it.jsr, it.descDrift);
        if (!r.ok) throw new Error(`set description — ${jsrErrorReason(r)}`);
        metaBits.push('description');
      }
      if (it.rcDrift) {
        const r = await client.setRuntimeCompat(it.jsr, it.rcDrift);
        if (!r.ok) throw new Error(`set runtimes — ${jsrErrorReason(r)}`);
        metaBits.push(`runtimes ${describeRuntimeCompat(it.rcDrift)}`);
      }
      if (metaBits.length) metaSynced++;
      const did = [
        didClaim && 'claimed',
        didLink && (didClaim ? 'linked' : 're-linked'),
        it.needsManifest && 'jsr.json created',
        ...metaBits,
      ]
        .filter(Boolean)
        .join(' + ');
      p.log.success(`${it.jsr.full} — ${did || 'already set up'}`);
    } catch (e) {
      p.log.error(`${it.jsr.full} — ${(e as Error).message}`);
      failures.push(it.jsr.full);
    }
    if (i < items.length - 1) await sleep(JSR_COOLDOWN_MS);
  }

  const blocked = blockedFrom >= 0 ? items.slice(blockedFrom).filter(it => !it.exists) : [];
  if (blocked.length) {
    note(
      `JSR allows at most ${pc.bold('20 new packages per scope per rolling week')}, and this scope just hit it.\n` +
        `${blocked.length} package(s) not claimed yet:\n` +
        blocked.map(it => `  ${pc.dim('·')} ${pc.cyan(it.jsr.full)}`).join('\n') +
        `\n\nRe-run ${cmd('fledgling jsr')} after the quota resets (or ask jsr.io for a raise) — already-claimed packages are skipped.`,
      '🛑 Weekly quota reached',
    );
  }

  if (!skipLink && linked && !failures.length) {
    p.log.info(
      `CI can now publish token-lessly: a workflow in ${pc.dim(repoSlug!)} with ${pc.bold('permissions: id-token: write')} running ${cmd('npx jsr publish')}.`,
    );
  }
  const tally = `claimed ${claimed}, linked ${linked}, metadata ${metaSynced}`;
  p.outro(
    failures.length
      ? pc.red(`Done with ${failures.length} failure(s) — ${tally}.`)
      : blocked.length
        ? pc.yellow(`${tally} — ${blocked.length} blocked by the weekly quota.`)
        : pc.green(`Done — ${tally}. 🐣`),
  );
  return failures.length || blocked.length ? 1 : 0;
}

export const jsrCommand = {
  name: 'jsr',
  description: 'Claim packages on JSR + link the repo for token-less OIDC publishing',
  args: jsrArgs,
  async run(ctx: Ctx) {
    const code = await runJsr(ctx.values, selectorsOf(ctx));
    if (code) process.exitCode = code;
  },
};
