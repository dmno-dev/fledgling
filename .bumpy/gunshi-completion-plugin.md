---
'fledgling': patch
---

Upgrade gunshi to 0.36 and switch shell completion to the official `@gunshi/plugin-completion` (replacing the hand-rolled `@bomb.sh/tab` integration). Completion behaves the same — package names, `--provider`, and `--permissions` still complete — and the `packages` argument is now documented in `--help`.
