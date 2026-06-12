import * as p from '@clack/prompts';
import pc from 'picocolors';
import { findWorkspaceRoot, detectRepo } from './workspace.js';
import { loadConfig, writeConfig, type NewdleConfig, type Permission } from './config.js';

/** `newdle init` — interactively write the `"newdle"` config into root package.json. */
export async function runInit(): Promise<number> {
  console.log();
  p.intro(pc.inverse(pc.cyan(' newdle init ')));

  const root = findWorkspaceRoot();
  const existing = loadConfig(root);
  const repoInfo = detectRepo(root);
  if (repoInfo) p.log.info(`Detected repo ${pc.dim(repoInfo.slug)} (auto-used unless you pass --repo)`);

  const provider = await p.select({
    message: 'CI provider (OIDC):',
    options: [
      { value: 'github', label: 'GitHub Actions' },
      { value: 'gitlab', label: 'GitLab CI/CD' },
      { value: 'circleci', label: 'CircleCI', hint: 'configured manually for now' },
    ],
    initialValue: existing.provider ?? 'github',
  });
  if (p.isCancel(provider)) return cancel();

  const workflow = await p.text({
    message: 'Publishing workflow filename:',
    initialValue: existing.workflow ?? 'release.yml',
    validate: v => (v?.trim() ? undefined : 'Required'),
  });
  if (p.isCancel(workflow)) return cancel();

  const environment = await p.text({
    message: 'CI environment (blank for none):',
    initialValue: existing.environment ?? 'publish',
  });
  if (p.isCancel(environment)) return cancel();

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

  const config: NewdleConfig = {
    provider: provider as NewdleConfig['provider'],
    workflow: String(workflow).trim(),
    ...(String(environment).trim() ? { environment: String(environment).trim() } : {}),
    permissions: permissions as Permission,
  };

  const file = writeConfig(root, config);
  p.note(JSON.stringify({ newdle: config }, null, 2), 'Saved');
  p.outro(pc.green(`Wrote config to ${pc.dim(file)} — now just run ${pc.bold('npx newdle')}`));
  return 0;
}

function cancel(): number {
  p.cancel('Cancelled.');
  return 1;
}
