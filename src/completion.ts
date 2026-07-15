import completion from '@gunshi/plugin-completion';
import { workspacePackages } from './core.js';

type Completion = { value: string; description?: string };

/** Complete workspace package names for the `packages` positional. */
const completePackages = (): Completion[] =>
  workspacePackages().map(p => ({ value: p.name, description: 'package' }));

/** Static value completions for the enum-ish string options. */
const completeProvider = (): Completion[] => [
  { value: 'github' },
  { value: 'gitlab' },
  { value: 'circleci' },
];
const completePermissions = (): Completion[] => [
  { value: 'publish' },
  { value: 'stage' },
  { value: 'both' },
];

/** Handlers for the npm-shaped commands (default / add / sync). */
const npmConfig = {
  args: {
    packages: { handler: completePackages },
    provider: { handler: completeProvider },
    permissions: { handler: completePermissions },
  },
};

/**
 * Shell completion plugin. Subcommands and every flag are derived automatically
 * from the commands' `args` schemas; we only supply handlers for the dynamic
 * values (workspace package names + the enum-ish `--provider` / `--permissions`).
 *
 * Installs via the auto-generated `complete` subcommand:
 *   fledgling complete zsh >> ~/.zshrc   (or bash | fish | powershell)
 */
export const completionPlugin = () =>
  completion({
    config: {
      entry: npmConfig,
      subCommands: {
        add: npmConfig,
        sync: npmConfig,
        jsr: { args: { packages: { handler: completePackages } } },
      },
    },
  });
