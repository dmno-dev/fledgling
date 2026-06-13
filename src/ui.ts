import * as p from '@clack/prompts';

/** A spinner that hatches: 🥚 → 🐣 → 🐥. */
export const hatchSpinner = () => p.spinner({ frames: ['🥚', '🥚', '🐣', '🐣', '🐥'], delay: 180 });
