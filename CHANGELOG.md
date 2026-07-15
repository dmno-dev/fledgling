# Changelog




## 1.2.0
<sub>2026-07-15</sub>

- [#7](https://github.com/dmno-dev/fledgling/pull/7)  *(minor)*
  New `fledgling jsr` command — the same first-publish story, on [JSR](https://jsr.io). Scaffolds missing `jsr.json` manifests from `package.json`, claims each package on jsr.io (JSR has no create-on-first-publish), links your GitHub repo so CI publishes token-lessly via OIDC (`npx jsr publish`, no `JSR_TOKEN` secret), and syncs the score metadata JSR only stores server-side — package **description** (from `package.json`) and **runtime compatibility** (from `fledgling.jsr.runtimeCompat` config). Idempotent (reconciles metadata drift on every run), rate-limit aware, and stops cleanly at JSR's 20-new-packages-per-week scope quota. Auth via a full-access JSR token in `$JSR_TOKEN`; configure a default scope for unscoped packages with `fledgling.jsr.scope`. Thanks to [@Saeris](https://github.com/Saeris) for the proposal and reference implementation this is built on.
- [#9](https://github.com/dmno-dev/fledgling/pull/9)  *(patch)*
  Upgrade gunshi to 0.36 and switch shell completion to the official `@gunshi/plugin-completion` (replacing the hand-rolled `@bomb.sh/tab` integration). Completion behaves the same — package names, `--provider`, and `--permissions` still complete — and the `packages` argument is now documented in `--help`.

## 1.1.1
<sub>2026-07-02</sub>

- [#4](https://github.com/dmno-dev/fledgling/pull/4)  *(patch)* - Warn up front when your npm account has 2FA disabled, instead of failing every claim with a raw 403.
- [#5](https://github.com/dmno-dev/fledgling/pull/5)  *(patch)*
  When claiming a brand-new name with `--new` and no repo can be resolved, skip trusted publishing (with a note) instead of erroring out the whole run — you can wire it up later with `fledgling sync`.

## 1.1.0
<sub>2026-06-18</sub>

- [#2](https://github.com/dmno-dev/fledgling/pull/2)  *(minor)* - Prompt for a new package name in the wizard.

## 1.0.0
<sub>2026-06-17</sub>

-  *(major)* - Initial release 🐣
  `fledgling` claims your npm package names and sets up token-less (OIDC) trusted publishing — for a single package or a whole monorepo.
  - **Claim names** by publishing a minimal `package.json`-only placeholder, so you can configure trusted publishing before your first real release
  - **Set up trusted publishing** via npm's own `npm trust` (OIDC) — no `NPM_TOKEN`, no clicking through the npm website
  - **GitHub, GitLab, and CircleCI** providers, supporting every option `npm trust` accepts
  - **Monorepo-aware** — npm / yarn / bun `workspaces` and pnpm, plus single-package repos; target packages by name or glob
  - **Interactive wizard** (powered by clack), with `add`, `sync`, and `init` subcommands; goes non-interactive with `--yes` or in CI
  - **`fledgling sync`** reconciles trusted publishing across every package against your config, showing the exact drift before fixing it
  - **2FA handled by npm itself** — an interactive browser approval (cached ~5 min) covers a whole run; pass `--otp`, or `--otp-secret` / `$FLEDGLING_OTP_SECRET` (a TOTP secret or `otpauth://` URI) for non-interactive use
  - **Exclude packages** from fledgling with a `fledgling.ignore` list (names or globs), beyond `"private": true`
  - **Idempotent** — re-run any time you add a package; it only does what's missing
  - **Configurable** via a `fledgling` block in `package.json`, with CLI flags as per-run overrides
  - **Shell completions** for zsh, bash, and fish
  - **`--dry-run`** to preview the plan without changing anything
