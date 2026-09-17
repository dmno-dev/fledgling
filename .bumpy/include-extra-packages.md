---
'fledgling': minor
---

New `include` config option: list exact package names that have no package.json in the workspace — e.g. per-platform native binary packages published as optional dependencies — and fledgling treats them like discovered packages (claimed, trusted, synced, tab-completed). They're npm-only; `fledgling jsr` skips them.
