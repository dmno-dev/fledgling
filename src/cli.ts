#!/usr/bin/env node
import { cli } from 'gunshi';
import pc from 'picocolors';
import { completionPlugin } from './completion.js';
import { entryCommand, addCommand } from './commands/add.command.js';
import { syncCommand } from './commands/sync.command.js';
import { initCommand } from './commands/init.command.js';
import { jsrCommand } from './commands/jsr.command.js';

declare const __VERSION__: string;
const VERSION = __VERSION__;

const rawArgv = process.argv.slice(2);

try {
  await cli(rawArgv, entryCommand, {
    name: 'fledgling',
    version: VERSION,
    description: '🐣 Create and set up packages on npm with trusted publishing',
    subCommands: { add: addCommand, sync: syncCommand, init: initCommand, jsr: jsrCommand },
    // shell completion (`fledgling complete <shell>`) — subcommands + flags are derived
    // from each command's `args`; see completion.ts for the dynamic-value handlers.
    plugins: [completionPlugin()],
    renderHeader: null, // no auto-printed banner on every run
  });
} catch (e) {
  const m = (e as Error).message?.match(/Command not found: (.+)/);
  if (m) {
    console.error(pc.red(`Unknown command '${m[1].trim()}'.`));
    console.error(pc.dim(`To set up a package by name, run: fledgling add ${m[1].trim()}`));
    process.exitCode = 1;
  } else {
    throw e;
  }
}
