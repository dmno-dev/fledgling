# fledgling 🐣

[![npm version](https://img.shields.io/npm/v/fledgling?color=cb3837&logo=npm)](https://www.npmjs.com/package/fledgling)
[![npm downloads](https://img.shields.io/npm/dm/fledgling?color=cb3837&logo=npm)](https://www.npmjs.com/package/fledgling)
[![node](https://img.shields.io/node/v/fledgling)](https://www.npmjs.com/package/fledgling)
[![license](https://img.shields.io/npm/l/fledgling?color=blue)](./LICENSE)

**Create and set up packages on npm with trusted publishing.**

> Brought to you by [Varlock](https://varlock.dev) 🧙‍♂️🔐 — [check it out to keep your secrets out of plaintext](https://varlock.dev).

`fledgling` claims your package name on npm and sets up token-less ([OIDC trusted](https://docs.npmjs.com/trusted-publishers/)) publishing — no `NPM_TOKEN`, no clicking through the npm website. It works for a single package or a whole monorepo, and it's idempotent, so you can re-run it any time you add a package.

<p align="center">
  <img src="https://raw.githubusercontent.com/dmno-dev/fledgling/main/images/demo.gif" alt="fledgling claiming a new package in a monorepo and setting up trusted publishing" width="760">
</p>

Designed to be run with `npx` (or `bunx` / `pnpm dlx`):

```sh
npx fledgling                                # interactive walkthrough (in a terminal)
npx fledgling add my-great-new-idea --new    # claim a brand-new name, nothing in the repo yet
npx fledgling add "*" --yes                  # every package in a monorepo (globs ok)
npx fledgling sync                           # reconcile trusted publishing to your config
```

Run bare `fledgling` in a terminal and you get an interactive wizard (powered by [clack](https://github.com/bombshell-dev/clack)); pass packages to `add` (or `--yes` / run in CI) and it goes non-interactive.

### Commands

| Command | What it does |
|---------|--------------|
| `fledgling` | Interactive wizard (the default) |
| `fledgling add [packages…]` | Claim names + set up trusted publishing for the given packages |
| `fledgling sync` | Reconcile trusted publishing on npm with your config |
| `fledgling init` | Write the trusted-publishing config to your `package.json` |
| `fledgling jsr [packages…]` | Claim packages on [JSR](https://jsr.io) + link the repo for OIDC publishing |

## Why

Setting up a new npm package the modern way is more fiddly than it should be:

1. npm won't let you configure trusted publishing until the package **already exists** — so you have to publish *something* first.
2. Then you configure the trusted publisher **per package**, by hand, on the website.
3. In a monorepo, you do that **N times**.

`fledgling` does all of it: publishes a tiny placeholder to claim each name, then configures the trusted publisher for every package via npm's own [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/). It's **idempotent** — re-run it whenever you add a package and it only does what's missing.

## Quick start

```sh
npm login        # needs 2FA enabled
npx fledgling       # interactive: pick packages, confirm, apply
```

Prefer non-interactive (or in CI)?

```sh
npx fledgling --dry-run    # print a plan, change nothing
npx fledgling --yes        # apply: claim names + configure trusted publishing
```

Then add the matching publish step to your CI (e.g. a GitHub Actions job with `permissions: id-token: write` running `npm publish`). Your real releases now publish over OIDC — no token required.

> 🐸 **Next step: [Bumpy](https://bumpy.varlock.dev)** handles exactly that publish step for you — it versions your packages, writes changelogs, and publishes over OIDC trusted publishing (no `NPM_TOKEN`). `fledgling` sets up the trust, Bumpy does the releasing — they pair perfectly. (This repo is released with it.)

## Configuration

**The recommended way to configure `fledgling` is a `"fledgling"` block in your root `package.json`.** Set it once and every run reads it — CLI flags are just per-run overrides. Create it interactively:

```sh
npx fledgling init
```

```jsonc
{
  "fledgling": {
    "provider": "github",       // github | gitlab | circleci
    "workflow": "release.yml",  // the workflow whose job runs `npm publish`
    "environment": "publish",   // CI environment for the trusted publisher (optional)
    "permissions": "publish"    // publish | stage | both
  }
}
```

**CircleCI** uses IDs instead of a workflow/repo:

```jsonc
{
  "fledgling": {
    "provider": "circleci",
    "orgId": "…",
    "projectId": "…",
    "pipelineDefinitionId": "…",
    "vcsOrigin": "github/owner/repo",
    "contextIds": ["…"],        // optional
    "permissions": "publish"
  }
}
```

Add `"registry"` to either block to target a non-default npm registry.

### Excluding packages

fledgling skips any package marked `"private": true`. To exclude **public** packages too —
internal-but-published things you never want it to claim or manage trust for — add an
`"ignore"` list of names or globs:

```jsonc
{
  "fledgling": {
    "ignore": ["@scope/internal-*", "playground"]
  }
}
```

Ignored packages are invisible to fledgling: they're left out of `add`, `sync`, `"*"`
globs, and tab completion.

### Defaults

| Option | Default | Notes |
|--------|---------|-------|
| `provider` | `github` | also `gitlab`, `circleci` |
| `repo` | _auto-detected_ from git `origin` | override with `--repo` |
| `workflow` | `release.yml` | the workflow whose job publishes |
| `environment` | **none** | Optional and **unset by default** — the trusted publisher then isn't tied to a CI environment (it works, but adds no environment gate). Setting one (e.g. `publish`) is recommended for security, and `fledgling init` pre-fills it. |
| `permissions` | `publish` | `publish`, `stage` (held for 2FA approval), or `both` |
| `registry` | _your npm config_ | optional custom npm registry URL |

**CircleCI** uses `orgId`, `projectId`, `pipelineDefinitionId`, `vcsOrigin`, and optional `contextIds` instead of `repo`/`workflow`/`environment`.

Precedence is **CLI flag → `fledgling` config → built-in default**.

### Just want to claim names?

To skip trusted publishing entirely and only reserve package names, you can:
- pass **`--skip-trust`** for a single run,
- decline the wizard's "Set up trusted publishing?" prompt, or
- set **`"trust": false`** in your `fledgling` config to make it the default.

## Usage

```sh
npx fledgling add [packages...] [options]
```

With no package arguments, `add` targets **every public package** in your workspace. Pass names or globs to narrow it down:

```sh
npx fledgling add my-pkg --yes              # one package
npx fledgling add "@scope/*" --yes          # a glob (quote it)
npx fledgling add "*-plugin" --yes          # all the plugins
npx fledgling add @scope/brand-new --new --yes   # claim a name that doesn't exist locally yet
```

Running bare `npx fledgling` (no subcommand) in a terminal drops you into the same flow interactively.

### Run options

| Flag | Description |
|------|-------------|
| `-y, --yes` | Apply changes without prompting (default in a terminal is the interactive wizard) |
| `--dry-run` | Print a plan without prompting (non-interactive) |
| `--new` | Treat unmatched names as brand-new packages to claim (squat a name) |
| `--skip-publish` | Only set up trusted publishing |
| `--skip-trust` | Only claim names |
| `--force` | Replace an existing trusted publisher (revoke + re-create) |
| `--placeholder-version <v>` | Placeholder version (default: `0.0.0`) |
| `--tag <tag>` | dist-tag for placeholders (default: `latest`) |
| `--otp <code>` | *(legacy)* npm 2FA one-time password, used for every npm call this run (also `$NPM_CONFIG_OTP`) |
| `--otp-secret <secret>` | *(legacy)* TOTP secret to generate 2FA codes from as needed (also `$FLEDGLING_OTP_SECRET`) |

By default you don't pass either — npm handles 2FA itself via the browser. See [2FA](#2fa).

### 2FA

npm requires 2FA to claim names and configure trusted publishing, and **the browser flow is
the normal path** — you won't pass anything to fledgling. npm kicks you out to the web to
approve with whatever your account uses (passkey, security key, or an authenticator code),
then caches that approval for ~5 minutes, so a single approval covers the whole run. When
prompted, tick **"don't ask again for 5 minutes"** so it doesn't ask once per package.

That's it for most people. fledgling stays out of the way — it just runs npm with the
terminal attached and lets npm prompt.

<details>
<summary><strong>Passing a one-time code instead (legacy)</strong></summary>

npm is moving away from authenticator codes in favor of WebAuthn (passkeys and security
keys), so treat this as a fallback that's on its way out — for a shell with no browser, or
an account still on TOTP. Note that WebAuthn can't be automated headlessly at all, so if
your account has moved off codes, these options simply won't apply.

- **`--otp <code>`** — a single one-time password, reused for every npm call in the run.
- **`NPM_CONFIG_OTP=<code>`** — same thing as an env var. It's npm's own config env var, and
  it keeps the code out of your process list.
- **`--otp-secret <secret>`** — your authenticator's TOTP secret (base32); fledgling
  generates a fresh code for each npm call. Prefer the **`FLEDGLING_OTP_SECRET`** env var
  over the flag so the secret doesn't land in your shell history or process list.

A single code expires in ~30s, so `--otp` / `NPM_CONFIG_OTP` may not survive a long run
across many packages — `--otp-secret` / `FLEDGLING_OTP_SECRET` mints a fresh one per call.

Pull either straight from a password manager — e.g. 1Password's CLI (`op`). The **generated
code** comes from `?attribute=otp`:

```sh
fledgling sync --otp "$(op read "op://Private/npm/Security/one-time password?attribute=otp")"
```

…or read the **secret itself** — the field's value with no attribute, an `otpauth://` URI —
into `FLEDGLING_OTP_SECRET`:

```sh
FLEDGLING_OTP_SECRET="$(op read "op://Private/npm/Security/one-time password")" fledgling sync
```

</details>

### Config flags

Better set once in `package.json` (see [Configuration](#configuration)); as flags they override the config for that run.

| Flag | Config key | Default |
|------|-----------|---------|
| `--provider <p>` | `provider` | `github` |
| `--permissions <p>` | `permissions` | `publish` |
| `--registry <url>` | `registry` | _npm config_ |
| `--repo <owner/repo>` | _(auto-detected)_ | git `origin` |
| `--workflow <file>` | `workflow` | `release.yml` |
| `--env <name>` | `environment` | none |
| `--org-id <uuid>` | `orgId` | _(circleci)_ |
| `--project-id <uuid>` | `projectId` | _(circleci)_ |
| `--pipeline-definition-id <uuid>` | `pipelineDefinitionId` | _(circleci)_ |
| `--vcs-origin <origin>` | `vcsOrigin` | _(circleci)_ |
| `--context-id <uuid>` | `contextIds` | _(circleci, repeatable)_ |

## What it does, precisely

For each target package:

1. **Claim** — if the name isn't on npm yet, publish a `package.json`-only placeholder (`0.0.0`, no code) to reserve it.
2. **Trust** — if there's no trusted publisher configured, set one up for your CI provider via `npm trust` (or replace an existing one with `--force`). Supports **GitHub, GitLab, and CircleCI**, with every option `npm trust` accepts.

Both steps are skipped when already done. Placeholders are packed from a throwaway temp dir, so your real `package.json` files are never touched.

## `fledgling sync` — reconcile trusted publishing

Where the default command focuses on **new** packages (and hides already-published ones), `fledgling sync` reconciles **trusted publishing across every package** against your `fledgling` config.

It authenticates, reads each package's actual config on npm, and shows what's **not configured** or **out of sync** — with the exact difference (e.g. `environment publish → (none)`) — then asks before fixing it to match your config:

```sh
fledgling sync            # auth, check, then confirm + apply
fledgling sync --yes      # skip the confirm
fledgling sync "@scope/*" # a subset
```

Use it after changing your `fledgling` config, or to set up trust on packages that were published without it. (It uses the same config/flags as the main command.)

## `fledgling jsr` — the same story on JSR

[JSR](https://jsr.io) has **no "create on first publish"** — every package must already exist on jsr.io before anything (CI or a human) can publish a version to it. For a monorepo that's the exact papercut fledgling exists to remove, so `fledgling jsr` does for JSR what the main command does for npm:

1. **Scaffold** — create a minimal `jsr.json` (name, version, a source `exports` entry) from each `package.json` where missing. An existing `jsr.json`/`deno.json` is authoritative and never rewritten.
2. **Claim** — create each missing package on jsr.io via the JSR management API.
3. **Link** — link your GitHub repo to each package, which is JSR's whole trusted-publishing setup: any workflow in the linked repo can then publish **token-lessly via OIDC** (`npx jsr publish` with `permissions: id-token: write` — no `JSR_TOKEN` secret in CI).
4. **Sync score metadata** — reconcile each package's **description** (from `package.json`) and **runtime compatibility** (from config) to jsr.io. [JSR scores packages](https://jsr.io/docs/scoring) partly on these, and — unlike npm — they live *only* on jsr.io (the `jsr.json` manifest has no `description` field), so they can't ride along at publish time. fledgling reconciles them here, where it already holds the token; only what's changed is pushed.

```sh
npx fledgling jsr                    # plan (interactive confirm in a terminal)
npx fledgling jsr --yes              # apply: scaffold + claim + link
npx fledgling jsr "@scope/*" --yes   # a subset
```

It's **idempotent** — claimed packages are skipped and the repo link is re-asserted, so re-run it whenever you add a package.

### Prerequisites

- A **JSR scope** you're a member of (create one at [jsr.io/new](https://jsr.io/new)) — fledgling doesn't create scopes.
- A JSR **personal access token** with **full access** in `$JSR_TOKEN` (jsr.io → Account → Tokens). A token restricted to "package publish" can publish versions but **cannot** create packages or link a repo — those are management operations. The token is used once, locally; it does **not** go into CI.

JSR names always have a scope. Packages whose npm name already has one (`@scope/pkg`) map straight across; for unscoped packages, set the scope once:

```jsonc
{
  "fledgling": {
    "jsr": {
      "scope": "myscope",     // JSR scope for unscoped npm names (or override with --scope)
      "manifest": true,       // set false to never scaffold jsr.json
      "metadata": true,       // set false to never sync description / runtime compat
      "runtimeCompat": {      // default runtime-compatibility flags (part of the JSR score)
        "node": true, "deno": true, "bun": true, "browser": true, "workerd": true
      }
    }
  }
}
```

The **description** is taken automatically from each package's `package.json` (collapsed to a single line and clamped to JSR's 250-char limit). **`runtimeCompat`** is deliberately *not* inferred — set it explicitly, either as the `fledgling.jsr.runtimeCompat` default above or per-package in that package's own `package.json` (a package's own value wins). Only runtimes you mark are changed; re-running reconciles drift, so edit `package.json` and re-run to update jsr.io.

### Flags

| Flag | Description |
|------|-------------|
| `-y, --yes` | Apply without prompting |
| `--dry-run` | Print a plan without prompting (non-interactive) |
| `--scope <scope>` | JSR scope for packages whose npm name has none (or to override it) |
| `--repo <owner/repo>` | GitHub repo to link (default: auto-detected from git `origin`) |
| `--token <token>` | JSR access token (prefer `$JSR_TOKEN` over the flag) |
| `--skip-manifest` | Don't scaffold missing `jsr.json` manifests |
| `--skip-link` | Only claim names — don't link the repo |
| `--skip-metadata` | Don't sync score metadata (description / runtime compat) |

### Good to know

- **Rate limits are handled.** JSR's management API throttles bulk operations aggressively; fledgling backs off (honouring `Retry-After`) and paces itself between packages.
- **20 new packages per scope per rolling week.** JSR hard-caps new package creation, so a larger monorepo can't be bootstrapped in one run. fledgling detects the quota, stops cleanly, and lists what's left — re-run after the reset (or ask jsr.io for a raise); it picks up where it left off.
- **JSR's OIDC is GitHub-only** today, and there's no per-workflow/environment config — the repo link is the whole setup.
- **JSR publishes TS source**, so scaffolded manifests point at your source entry (your `development`/`source` export condition, or `./src/index.ts`), not built output.

> 🙏 Thanks to [@Saeris](https://github.com/Saeris) for the groundwork that made this feature possible — the [proposal and reference implementation](https://github.com/mirrordown/mirrordown) (including the live findings on JSR's rate limits and weekly quota) that `fledgling jsr` is built on.

## Shell completions

`fledgling` ships tab-completion (via [`@bomb.sh/tab`](https://github.com/bombshell-dev/tab)) that completes package names and flags. Install it for your shell:

```sh
fledgling complete zsh  >> ~/.zshrc
fledgling complete bash >> ~/.bashrc
fledgling complete fish >  ~/.config/fish/completions/fledgling.fish
```

Then `fledgling <TAB>` completes the packages in your workspace.

## Requirements

- **Node** ≥ 18
- **npm** ≥ 11.15.0 (for `npm trust` + OIDC/staged publishing)
- `npm login` with **2FA enabled** for the trust step (npm requires it)

Supports **npm / yarn / bun** (`workspaces`) and **pnpm** (`pnpm-workspace.yaml`) monorepos, plus single-package repos.

## License

[MIT](./LICENSE) © DMNO Inc

---

<p align="center">
  <a href="https://varlock.dev" target="_blank" rel="noopener noreferrer">
    <img src="https://raw.githubusercontent.com/dmno-dev/fledgling/main/images/github-readme-footer.png" alt="fledgling was created by Varlock">
  </a>
</p>
<p align="center">
  <b>fledgling is a creation of the team behind <a href="https://varlock.dev">Varlock</a> 🧙‍♂️</b><br/>
  <a href="https://varlock.dev">Check it out for secure secret sorcery — get your keys out of plaintext!</a>
</p>
