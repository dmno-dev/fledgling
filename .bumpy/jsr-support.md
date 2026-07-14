---
'fledgling': minor
---

New `fledgling jsr` command — the same first-publish story, on [JSR](https://jsr.io). Scaffolds missing `jsr.json` manifests from `package.json`, claims each package on jsr.io (JSR has no create-on-first-publish), links your GitHub repo so CI publishes token-lessly via OIDC (`npx jsr publish`, no `JSR_TOKEN` secret), and syncs the score metadata JSR only stores server-side — package **description** (from `package.json`) and **runtime compatibility** (from `fledgling.jsr.runtimeCompat` config). Idempotent (reconciles metadata drift on every run), rate-limit aware, and stops cleanly at JSR's 20-new-packages-per-week scope quota. Auth via a full-access JSR token in `$JSR_TOKEN`; configure a default scope for unscoped packages with `fledgling.jsr.scope`. Thanks to [@Saeris](https://github.com/Saeris) for the proposal and reference implementation this is built on.
