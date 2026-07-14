import * as p from '@clack/prompts';
import pc from 'picocolors';
import { findWorkspaceRoot, detectRepo } from '../workspace.js';
import { loadConfig, writeConfig, type FledglingConfig, type Permission, type Provider } from '../config.js';
import { hatchIntro, note } from '../ui.js';

const CANCEL = Symbol('cancel');
/** Prompt for required text; returns the trimmed value or CANCEL. */
async function ask(message: string, initialValue?: string, required = true): Promise<string | typeof CANCEL> {
  const v = await p.text({
    message,
    initialValue,
    validate: required ? x => (x?.trim() ? undefined : 'Required') : undefined,
  });
  if (p.isCancel(v)) return CANCEL;
  return String(v ?? '').trim();
}

/** `fledgling init` — interactively write the `"fledgling"` config into root package.json. */
export async function runInit(): Promise<number> {
  console.log();
  await hatchIntro('fledgling init');

  const root = findWorkspaceRoot();
  const existing = loadConfig(root);
  const repoInfo = detectRepo(root);
  if (repoInfo) p.log.info(`Detected repo ${pc.dim(repoInfo.slug)} (auto-used unless you pass --repo)`);

  const provider = await p.select({
    message: 'CI provider (OIDC):',
    options: [
      { value: 'github', label: 'GitHub Actions' },
      { value: 'gitlab', label: 'GitLab CI/CD' },
      { value: 'circleci', label: 'CircleCI' },
    ],
    initialValue: existing.provider ?? 'github',
  });
  if (p.isCancel(provider)) return cancel();

  const config: FledglingConfig = { provider: provider as Provider };

  if (provider === 'circleci') {
    const orgId = await ask('CircleCI org id (UUID):', existing.orgId);
    if (orgId === CANCEL) return cancel();
    const projectId = await ask('CircleCI project id (UUID):', existing.projectId);
    if (projectId === CANCEL) return cancel();
    const pipelineDefinitionId = await ask('CircleCI pipeline definition id (UUID):', existing.pipelineDefinitionId);
    if (pipelineDefinitionId === CANCEL) return cancel();
    const vcsOrigin = await ask('VCS origin (e.g. github/owner/repo):', existing.vcsOrigin);
    if (vcsOrigin === CANCEL) return cancel();
    const contexts = await ask('Context UUIDs (comma-separated, blank for none):', existing.contextIds?.join(','), false);
    if (contexts === CANCEL) return cancel();
    Object.assign(config, { orgId, projectId, pipelineDefinitionId, vcsOrigin });
    const ids = contexts.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length) config.contextIds = ids;
  } else {
    const workflow = await ask('Publishing workflow filename:', existing.workflow ?? 'release.yml');
    if (workflow === CANCEL) return cancel();
    const environment = await ask('CI environment (blank for none):', existing.environment ?? 'publish', false);
    if (environment === CANCEL) return cancel();
    config.workflow = workflow;
    if (environment) config.environment = environment;
  }

  const permissions = await p.select({
    message: 'Publish permissions to grant:',
    options: [
      { value: 'publish', label: 'publish', hint: 'standard npm publish' },
      { value: 'stage', label: 'staged', hint: 'npm stage — held for 2FA approval' },
      { value: 'both', label: 'both' },
    ],
    initialValue: existing.permissions ?? 'publish',
  });
  if (p.isCancel(permissions)) return cancel();
  config.permissions = permissions as Permission;

  const registry = await ask('Custom npm registry (blank for default):', existing.registry, false);
  if (registry === CANCEL) return cancel();
  if (registry) config.registry = registry;

  const file = writeConfig(root, config);
  note(JSON.stringify({ fledgling: config }, null, 2), 'Saved');
  p.outro(pc.green(`Wrote config to ${pc.dim(file)} — now just run ${pc.bold('npx fledgling')}`));
  return 0;
}

function cancel(): number {
  p.cancel('Cancelled.');
  return 1;
}

export const initCommand = {
  name: 'init',
  description: 'Write trusted-publishing config to your package.json',
  async run() {
    const code = await runInit();
    if (code) process.exitCode = code;
  },
};
