import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** npm trusted-publisher permissions to grant. */
export type Permission = 'publish' | 'stage' | 'both';

/** Persisted config, read from the `"newdle"` key of the root package.json. */
export interface NewdleConfig {
  provider?: 'github' | 'gitlab' | 'circleci';
  workflow?: string;
  environment?: string;
  permissions?: Permission;
}

export function loadConfig(root: string): NewdleConfig {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return {};
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')).newdle;
    return cfg && typeof cfg === 'object' ? (cfg as NewdleConfig) : {};
  } catch {
    return {};
  }
}

/** Write the `"newdle"` key into the root package.json, preserving its indentation. */
export function writeConfig(root: string, config: NewdleConfig): string {
  const file = join(root, 'package.json');
  const raw = readFileSync(file, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.newdle = config;
  writeFileSync(file, JSON.stringify(pkg, null, detectIndent(raw)) + '\n');
  return file;
}

function detectIndent(raw: string): string | number {
  const m = raw.match(/^([ \t]+)"/m);
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}
