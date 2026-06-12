import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  target: 'node18',
  dts: false,
  // the #!/usr/bin/env node shebang in cli.ts is preserved in the output
});
