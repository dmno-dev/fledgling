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

type Cmd = {
  argument(name: string, handler: (complete: (v: string, d?: string) => void) => void, variadic?: boolean): Cmd;
  option(flag: string, desc: string, handler?: (complete: (v: string, d?: string) => void) => void): Cmd;
};

/** Wire the package-name positional + every flag onto a command. */
function withPackageArgsAndFlags(cmd: Cmd): void {
  cmd.argument(
    'packages',
    complete => {
      for (const p of workspacePackages()) complete(p.name, 'package');
    },
    true,
  );
  cmd.option('--provider', 'CI provider', complete => {
    complete('github', '');
    complete('gitlab', '');
    complete('circleci', '');
  });
  cmd.option('--permissions', 'trust permissions', complete => {
    complete('publish', '');
    complete('stage', '');
    complete('both', '');
  });
  for (const [flag, desc] of FLAGS) cmd.option(flag, desc);
}

function defineCompletions(): void {
  // subcommands: `add` / `sync` take package selectors + flags, `init` takes nothing
  withPackageArgsAndFlags(t.command('add', 'claim names + set up trusted publishing') as unknown as Cmd);
  withPackageArgsAndFlags(t.command('sync', 'reconcile trusted publishing with your config') as unknown as Cmd);
  t.command('init', 'write trusted-publishing config to package.json');

  // bare `fledgling …` (default command) also accepts selectors + flags
  withPackageArgsAndFlags(t as unknown as Cmd);
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
