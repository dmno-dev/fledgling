import * as p from '@clack/prompts';
import { setTimeout as sleep } from 'node:timers/promises';

const CLEAR_LINE = '\r\x1b[2K';

/** A spinner that hatches: 🥚 → 🐣 → 🐥. */
export const hatchSpinner = () => p.spinner({ frames: ['🥚', '🥚', '🐣', '🐣', '🐥'], delay: 180 });

/** A short one-shot hatch animation shown at startup (TTY only). */
export async function hatch(): Promise<void> {
  if (!process.stdout.isTTY) return;
  const frames = ['🥚', '🥚', '🥚', '🐣', '🐣', '🐥'];
  for (const f of frames) {
    process.stdout.write(`${CLEAR_LINE}  ${f} `);
    await sleep(170);
  }
  process.stdout.write(CLEAR_LINE);
}
