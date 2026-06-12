# newdle

[![npm version](https://img.shields.io/npm/v/newdle?color=cb3837&logo=npm)](https://www.npmjs.com/package/newdle)
[![npm downloads](https://img.shields.io/npm/dm/newdle?color=cb3837&logo=npm)](https://www.npmjs.com/package/newdle)
[![node](https://img.shields.io/node/v/newdle)](https://www.npmjs.com/package/newdle)
[![license](https://img.shields.io/npm/l/newdle?color=blue)](./LICENSE)

**Create and set up packages on npm with trusted publishing.**

`newdle` claims your package name on npm and sets up token-less ([OIDC trusted](https://docs.npmjs.com/trusted-publishers/)) publishing — no `NPM_TOKEN`, no clicking through the npm website. It works for a single package or a whole monorepo, and it's idempotent, so you can re-run it any time you add a package.

Designed to be run with `npx` (or `bunx` / `pnpm dlx`):

```sh
npx newdle                            # interactive walkthrough (in a terminal)
npx newdle my-great-new-idea --new    # claim a brand-new name, nothing in the repo yet
npx newdle "*" --yes                  # every package in a monorepo
npx newdle "@scope/utils-*" --yes     # accepts globs
```

Run it in a terminal and you get an interactive wizard (powered by [clack](https://github.com/bombshell-dev/clack)); pass `--yes` (or run in CI) and it goes non-interactive.

## Why

Setting up a new npm package the modern way is more fiddly than it should be:

1. npm won't let you configure trusted publishing until the package **already exists** — so you have to publish *something* first.
2. Then you configure the trusted publisher **per package**, by hand, on the website.
3. In a monorepo, you do that **N times**.

`newdle` does all of it: publishes a tiny placeholder to claim each name, then configures the trusted publisher for every package via npm's own [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/). It's **idempotent** — re-run it whenever you add a package and it only does what's missing.

## Quick start

```sh
npm login        # needs 2FA enabled
npx newdle       # interactive: pick packages, confirm, apply
```

Prefer non-interactive (or in CI)?

```sh
npx newdle --dry-run    # print a plan, change nothing
npx newdle --yes        # apply: claim names + configure trusted publishing
```

Then add the matching publish step to your CI (e.g. a GitHub Actions job with `permissions: id-token: write` running `npm publish`). Your real releases now publish over OIDC — no token required.

## Usage

```sh
npx newdle [packages...] [options]
```

With no package arguments, `newdle` targets **every public package** in your workspace. Pass names or globs to narrow it down:

```sh
npx newdle my-pkg --yes              # one package
npx newdle "@scope/*" --yes          # a glob (quote it)
npx newdle "*-plugin" --yes          # all the plugins
npx newdle @scope/brand-new --new --yes   # claim a name that doesn't exist locally yet
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
| `--allow-stage-publish` | Also grant staged-publish permission |

## What it does, precisely

For each target package:

1. **Claim** — if the name isn't on npm yet, publish a `package.json`-only placeholder (`0.0.0`, no code) to reserve it.
2. **Trust** — if there's no trusted publisher configured, set one up for your CI provider via `npm trust`.

Both steps are skipped when already done. Placeholders are packed from a throwaway temp dir, so your real `package.json` files are never touched.

## Shell completions

`newdle` ships tab-completion (via [`@bomb.sh/tab`](https://github.com/bombshell-dev/tab)) that completes package names and flags. Install it for your shell:

```sh
newdle complete zsh  >> ~/.zshrc
newdle complete bash >> ~/.bashrc
newdle complete fish >  ~/.config/fish/completions/newdle.fish
```

Then `newdle <TAB>` completes the packages in your workspace.

## Requirements

- **Node** ≥ 18
- **npm** ≥ 11.10 (for `npm trust`)
- `npm login` with **2FA enabled** for the trust step (npm requires it)

Supports **npm / yarn / bun** (`workspaces`) and **pnpm** (`pnpm-workspace.yaml`) monorepos, plus single-package repos.

## License

[MIT](./LICENSE)
