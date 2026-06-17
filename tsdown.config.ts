import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  target: 'node18',
  dts: false,
  // baked in at build time — the publish job builds after bumpy bumps the version
  define: { __VERSION__: JSON.stringify(pkg.version) },
  // the #!/usr/bin/env node shebang in cli.ts is preserved in the output
});
