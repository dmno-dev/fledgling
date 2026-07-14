/**
 * gunshi keeps the matched subcommand name in `positionals` (e.g. `add foo` →
 * `['add','foo']` with `commandPath: ['add']`), so drop the command path to get
 * the real package selectors. The default command has an empty path, so this is a
 * no-op there.
 */
export type Ctx = { values: Record<string, any>; positionals?: string[]; commandPath?: string[] };
export const selectorsOf = (ctx: Ctx): string[] => (ctx.positionals ?? []).slice(ctx.commandPath?.length ?? 0);

/** The npm-shaped flag set shared by the default, `add`, and `sync` commands. */
export const npmArgs = {
  // run options (per invocation)
  yes: { type: 'boolean', short: 'y', description: 'Apply changes without prompting (default: interactive / dry run)' },
  'dry-run': { type: 'boolean', description: 'Print a plan without prompts (non-interactive)' },
  new: { type: 'boolean', description: 'Treat unmatched names as brand-new packages to claim' },
  'skip-publish': { type: 'boolean', description: 'Only set up trusted publishing' },
  'skip-trust': { type: 'boolean', description: 'Only claim names' },
  force: { type: 'boolean', description: 'Replace an existing trusted publisher (revoke + re-create)' },
  'placeholder-version': { type: 'string', default: '0.0.0', description: 'Placeholder version to publish' },
  tag: { type: 'string', description: 'dist-tag for placeholders' },
  otp: { type: 'string', description: 'npm 2FA one-time password (used for every npm call this run)' },
  'otp-secret': { type: 'string', description: 'TOTP secret to generate 2FA codes from (use $FLEDGLING_OTP_SECRET to avoid shell history)' },
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
