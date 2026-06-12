import t from '@bomb.sh/tab';
import { workspacePackages } from './core.js';

const FLAGS: [string, string][] = [
  ['--yes', 'apply changes without prompting'],
  ['--new', 'claim brand-new names not in the repo'],
  ['--skip-publish', 'only set up trusted publishing'],
  ['--skip-trust', 'only claim names'],
  ['--dry-run', 'print a plan without prompting'],
  ['--repo', 'trusted-publisher repo (owner/repo)'],
  ['--workflow', 'publishing workflow filename'],
  ['--env', 'CI environment'],
  ['--placeholder-version', 'placeholder version'],
  ['--tag', 'dist-tag for placeholders'],
  ['--otp', 'npm one-time password'],
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
 * `newdle complete <shell>` prints an install script; the shell calls
 * `newdle complete -- <words…>` to get dynamic completions.
 * Returns true if it handled the invocation.
 */
export function maybeHandleCompletion(argv: string[]): boolean {
  if (argv[0] !== 'complete') return false;
  defineCompletions();
  const arg = argv[1];
  if (arg === '--') {
    t.parse(argv.slice(2));
  } else if (arg) {
    t.setup('newdle', 'newdle', arg); // arg = bash | zsh | fish | powershell
  } else {
    console.log('Usage: newdle complete <bash|zsh|fish|powershell>');
    console.log('e.g.  newdle complete zsh >> ~/.zshrc');
  }
  return true;
}
