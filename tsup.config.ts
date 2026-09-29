import { defineConfig, type Options } from 'tsup';

/**
 * Build configuration.
 *
 * I. Why two entry points
 *
 * 1. `cli` carries the `#!/usr/bin/env node` banner and becomes the published
 *    binary declared under `bin` in package.json.
 * 2. `index` is the library surface, so the scanner and rule engine can be
 *    embedded in CI tooling without shelling out to the CLI.
 *
 * II. Why runtime dependencies stay external
 *
 * 1. Bundling React into the CLI would duplicate the reconciler for any
 *    consumer that already has React, and it breaks Ink's own
 *    `react-reconciler` resolution. Every runtime dependency is therefore left
 *    external and resolved from `node_modules` at run time.
 *
 * III. Why two separate builds
 *
 * 1. Only the CLI entry needs the executable shebang. tsup applies `banner`
 *    per build, so declaring one config per entry is the only way to keep the
 *    shebang off the library bundle.
 */
const shared: Pick<
  Options,
  'format' | 'target' | 'platform' | 'outDir' | 'splitting' | 'sourcemap' | 'shims' | 'external'
> = {
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  shims: false,
  external: ['react', 'ink', 'commander', 'fast-glob', 'picocolors', 'zod'],
};

export default defineConfig([
  {
    ...shared,
    entry: { cli: 'src/cli/index.ts' },
    clean: true,
    dts: false,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    clean: false,
    dts: { entry: { index: 'src/index.ts' } },
  },
]);
