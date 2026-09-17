import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeCompat } from './jsr.js';

/** @deprecated Old `permissions` values — see `resolvePublish`. */
export type Permission = 'publish' | 'stage' | 'both';

export type Provider = 'github' | 'gitlab' | 'circleci';

/** JSR settings, used by `fledgling jsr`. */
export interface JsrConfig {
  /** JSR scope (with or without the @) for packages whose npm name doesn't carry one. */
  scope?: string;
  /** Set to false to skip scaffolding missing jsr.json manifests. */
  manifest?: boolean;
  /** Set to false to skip syncing score metadata (description / runtime compat) to JSR. */
  metadata?: boolean;
  /**
   * Default runtime-compatibility flags to publish to JSR (part of the package score).
   * A package's own `fledgling.jsr.runtimeCompat` in its package.json overrides this.
   */
  runtimeCompat?: RuntimeCompat;
}

/** Persisted config, read from the `"fledgling"` key of the root package.json. */
export interface FledglingConfig {
  /** Set to false to skip trusted publishing by default (just claim names). */
  trust?: boolean;
  /** Package names/globs to exclude from fledgling entirely (besides `"private": true`). */
  ignore?: string[];
  provider?: Provider;
  /**
   * May the trusted publisher run `npm publish` directly? (default: true). npm always
   * allows `npm stage` for a trusted publisher; this is the only choice npm offers.
   */
  publish?: boolean;
  /** @deprecated Use `publish`. `publish`/`both` → true, `stage` → false. */
  permissions?: Permission;
  /** custom npm registry (defaults to the configured/default registry) */
  registry?: string;
  // github / gitlab
  workflow?: string;
  environment?: string;
  // circleci (all required when provider is circleci)
  orgId?: string;
  projectId?: string;
  pipelineDefinitionId?: string;
  vcsOrigin?: string;
  contextIds?: string[];
  jsr?: JsrConfig;
}

/**
 * Resolve the direct-publish choice: `--publish`/`--no-publish` → config `publish` → the
 * deprecated `permissions` (flag or config) → true. Returns a deprecation note when the
 * old key decided it, for the caller to surface.
 */
export function resolvePublish(
  values: { publish?: boolean; permissions?: string },
  config: Pick<FledglingConfig, 'publish' | 'permissions'>,
): { publish: boolean; deprecated?: string } {
  if (values.publish !== undefined) return { publish: values.publish };
  if (config.publish !== undefined) return { publish: config.publish };
  const legacy = values.permissions ?? config.permissions;
  if (legacy !== undefined) {
    const publish = legacy !== 'stage';
    const where = values.permissions !== undefined ? '--permissions' : '`"permissions"` in your fledgling config';
    return {
      publish,
      deprecated:
        `${where} is deprecated — npm always allows staged publishing, so the only choice is direct publish. ` +
        `Use ${publish ? '`"publish": true` (or --publish)' : '`"publish": false` (or --no-publish)'} instead.`,
    };
  }
  return { publish: true };
}

export function loadConfig(root: string): FledglingConfig {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return {};
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')).fledgling;
    return cfg && typeof cfg === 'object' ? (cfg as FledglingConfig) : {};
  } catch {
    return {};
  }
}

/** Write the `"fledgling"` key into the root package.json, preserving its indentation. */
export function writeConfig(root: string, config: FledglingConfig): string {
  const file = join(root, 'package.json');
  const raw = readFileSync(file, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.fledgling = config;
  writeFileSync(file, JSON.stringify(pkg, null, detectIndent(raw)) + '\n');
  return file;
}

function detectIndent(raw: string): string | number {
  const m = raw.match(/^([ \t]+)"/m);
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}
