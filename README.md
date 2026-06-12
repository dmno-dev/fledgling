# fledgling 🐣

[![npm version](https://img.shields.io/npm/v/fledgling?color=cb3837&logo=npm)](https://www.npmjs.com/package/fledgling)
[![npm downloads](https://img.shields.io/npm/dm/fledgling?color=cb3837&logo=npm)](https://www.npmjs.com/package/fledgling)
[![node](https://img.shields.io/node/v/fledgling)](https://www.npmjs.com/package/fledgling)
[![license](https://img.shields.io/npm/l/fledgling?color=blue)](./LICENSE)

Brought to you by [Varlock](https://varlock.dev) 🧙‍♂️🔐 — [check it out to keep your secrets out of plaintext](https://varlock.dev).

**Create and set up packages on npm with trusted publishing.**

`fledgling` claims your package name on npm and sets up token-less ([OIDC trusted](https://docs.npmjs.com/trusted-publishers/)) publishing — no `NPM_TOKEN`, no clicking through the npm website. It works for a single package or a whole monorepo, and it's idempotent, so you can re-run it any time you add a package.

Designed to be run with `npx` (or `bunx` / `pnpm dlx`):

```sh
npx fledgling                            # interactive walkthrough (in a terminal)
npx fledgling my-great-new-idea --new    # claim a brand-new name, nothing in the repo yet
npx fledgling "*" --yes                  # every package in a monorepo
npx fledgling "@scope/utils-*" --yes     # accepts globs
```

Run it in a terminal and you get an interactive wizard (powered by [clack](https://github.com/bombshell-dev/clack)); pass `--yes` (or run in CI) and it goes non-interactive.

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

## Usage

```sh
npx fledgling [packages...] [options]
```

With no package arguments, `fledgling` targets **every public package** in your workspace. Pass names or globs to narrow it down:

```sh
npx fledgling my-pkg --yes              # one package
npx fledgling "@scope/*" --yes          # a glob (quote it)
npx fledgling "*-plugin" --yes          # all the plugins
npx fledgling @scope/brand-new --new --yes   # claim a name that doesn't exist locally yet
```

### Options

| Flag | Description |
|------|-------------|
| `-y, --yes` | Apply changes without prompting (default in a terminal is the interactive wizard) |
| `--dry-run` | Print a plan without prompting (non-interactive) |
| `--new` | Treat unmatched names as brand-new packages to claim (squat a name) |
| `--skip-publish` | Only set up trusted publishing |
| `--skip-trust` | Only claim names |
| `--provider <p>` | CI provider: `github` (default), `gitlab`, `circleci` |
| `--repo <owner/repo>` | Trusted-publisher repo (auto-detected from your git `origin`) |
| `--workflow <file>` | Publishing workflow filename (default: `release.yml`) |
| `--env <name>` | CI environment for the trusted publisher |
| `--placeholder-version <v>` | Placeholder version (default: `0.0.0`) |
| `--tag <tag>` | dist-tag for placeholders (default: `latest`) |
| `--otp <code>` | npm one-time password |
| `--permissions <p>` | Permissions to grant: `publish` (default), `stage`, or `both` |

## What it does, precisely

For each target package:

1. **Claim** — if the name isn't on npm yet, publish a `package.json`-only placeholder (`0.0.0`, no code) to reserve it.
2. **Trust** — if there's no trusted publisher configured, set one up for your CI provider via `npm trust`.

Both steps are skipped when already done. Placeholders are packed from a throwaway temp dir, so your real `package.json` files are never touched.

## Configuration

Set your defaults once instead of passing flags every time. Run:

```sh
npx fledgling init
```

…and it writes a `"fledgling"` block to your root `package.json`:

```jsonc
{
  "fledgling": {
    "provider": "github",       // github | gitlab | circleci
    "workflow": "release.yml",  // the workflow whose job publishes
    "environment": "publish",   // CI environment for the trusted publisher
    "permissions": "publish"    // publish | stage | both
  }
}
```

Settings resolve with precedence **CLI flag → `fledgling` config → built-in default** (the repo is auto-detected from your git `origin` unless you pass `--repo`). The `permissions` choice maps to npm trust: `publish` grants `npm publish`, `stage` grants `npm stage` (held for 2FA approval), `both` grants both.

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
- **npm** ≥ 11.10 (for `npm trust`)
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
