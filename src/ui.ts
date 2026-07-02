import * as p from '@clack/prompts';
import pc from 'picocolors';
import { setTimeout as sleep } from 'node:timers/promises';
import { npmTwoFactorStatus } from './npm.js';

const BAR_START = '┌'; // ┌  (matches clack's intro)

/** Style a runnable command so it reads as a command, not prose. */
export const cmd = (s: string): string => pc.cyan(pc.bold(s));

/**
 * Like clack's `note`, but without its default behavior of dimming the whole body —
 * we color our own content, so render each line as-is and let explicit `pc.dim`
 * (e.g. `(none)`, footnotes) be the only dimmed bits.
 */
export const note = (message: string, title?: string): void =>
  p.note(message, title, { format: line => line });

/** Heads-up shown before npm's interactive 2FA, so one approval covers the whole run. */
export const otpBoxReminder =
  `npm will open your browser to approve 2FA — tick ${pc.bold(`"don't ask again for 5 minutes"`)} ` +
  `so it won't prompt again for every package.`;

/** Shown when the logged-in npm account has 2FA off — publishing/trust will 403 without it. */
const twoFactorDisabledWarning = pc.yellow(
  `Your npm account doesn't have 2FA enabled — npm requires it to publish/configure trust, so this will fail with a 403.\n` +
    `Enable it at ${pc.underline('https://www.npmjs.com/settings/~/profile')} (or authenticate with a granular access token that has "bypass 2FA").`,
);

/**
 * If the account's 2FA is disabled, emit the warning via `warn` (whatever logger the
 * caller uses — clack, console, …). A no-op when 2FA is on or can't be read, so callers
 * just decide *when* to check (logged in? applying?) — not what to say. See `npmTwoFactorStatus`.
 */
export function warnIfTwoFactorDisabled(registry: string | undefined, warn: (msg: string) => void): void {
  if (npmTwoFactorStatus(registry) === 'disabled') warn(twoFactorDisabledWarning);
}

/** A spinner that hatches: 🥚 → 🐣 → 🐥. */
export const hatchSpinner = () => p.spinner({ frames: ['🥚', '🥚', '🐣', '🐣', '🐥'], delay: 180 });

/** clack's intro line, drawn ourselves so we can animate the title into it. */
const introLine = (content: string) => `${pc.gray(BAR_START)}  ${content}`;

/**
 * Animated clack-style intro: an egg hatches (🥚→🐣→🐥), then the title types
 * out letter by letter — ending as the box-opening `┌` line so the rest of the
 * clack flow lines up underneath. Falls back to a static line off-TTY.
 */
export async function hatchIntro(title: string): Promise<void> {
  const out = process.stdout;
  if (!out.isTTY) {
    out.write(`${introLine(`🐥 ${pc.cyan(title)}`)}\n`);
    return;
  }
  // egg rocks back and forth (constant-width frames so \r redraws clean)…
  for (const egg of ['🥚 ', ' 🥚', '🥚 ', ' 🥚', '🥚 ', ' 🥚', '🥚 ']) {
    out.write(`\r${introLine(egg)}`);
    await sleep(105);
  }
  // …then cracks and hatches
  for (const egg of ['🐣 ', '🐣 ', '🐥 ']) {
    out.write(`\r${introLine(egg)}`);
    await sleep(210);
  }
  // title types out letter by letter after the chick
  for (let i = 0; i <= title.length; i++) {
    out.write(`\r${introLine(`🐥 ${pc.cyan(title.slice(0, i))}`)}`);
    await sleep(55);
  }
  out.write('\n');
}
