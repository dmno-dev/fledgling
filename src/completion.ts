import t from '@bomb.sh/tab';
import { workspacePackages } from './core.js';

const FLAGS: [string, string][] = [
  ['--yes', 'apply changes without prompting'],
  ['--new', 'claim brand-new names not in the repo'],
  ['--skip-publish', 'only set up trusted publishing'],
  ['--skip-trust', 'only claim names'],
  ['--force', 'replace an existing trusted publisher'],
  ['--dry-run', 'print a plan without prompting'],
  ['--placeholder-version', 'placeholder version'],
  ['--tag', 'dist-tag for placeholders'],
  ['--otp', 'npm one-time password'],
  ['--registry', 'npm registry URL'],
  ['--repo', 'trusted-publisher repo (owner/repo)'],
  ['--workflow', 'publishing workflow filename'],
  ['--env', 'CI environment'],
  ['--org-id', 'CircleCI organization UUID'],
  ['--project-id', 'CircleCI project UUID'],
  ['--pipeline-definition-id', 'CircleCI pipeline definition UUID'],
  ['--vcs-origin', 'CircleCI VCS origin (github/owner/repo)'],
  ['--context-id', 'CircleCI context UUID (repeatable)'],
];

function defineCompletions(): void {
  // positional package selectors → complete with workspace package names
  t.argument(
    'packages',
    complete => {
      for (const p of workspacePackages()) complete(p.name, 'package');
    },
    true,
  );

  t.option('--provider', 'CI provider', complete => {
    complete('github', '');
    complete('gitlab', '');
    complete('circleci', '');
  });
  t.option('--permissions', 'trust permissions', complete => {
    complete('publish', '');
    complete('stage', '');
    complete('both', '');
  });
  for (const [flag, desc] of FLAGS) t.option(flag, desc);
}

/**
 * Handle the hidden `complete` subcommand (shell completion).
 * `fledgling complete <shell>` prints an install script; the shell calls
 * `fledgling complete -- <words…>` to get dynamic completions.
 * Returns true if it handled the invocation.
 */
export function maybeHandleCompletion(argv: string[]): boolean {
  if (argv[0] !== 'complete') return false;
  defineCompletions();
  const arg = argv[1];
  if (arg === '--') {
    t.parse(argv.slice(2));
  } else if (arg) {
    t.setup('fledgling', 'fledgling', arg); // arg = bash | zsh | fish | powershell
  } else {
    console.log('Usage: fledgling complete <bash|zsh|fish|powershell>');
    console.log('e.g.  fledgling complete zsh >> ~/.zshrc');
  }
  return true;
}
