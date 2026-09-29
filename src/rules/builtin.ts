/**
 * Built-in Clean Rule Catalog
 *
 * Declares every removable directory DevEnvClean knows about, grouped by the
 * ecosystem that owns it.
 *
 * I. How to read this file
 *
 * 1. Each entry describes *one directory shape*, not one directory instance. The
 *    scanner expands a rule into as many targets as the filesystem yields.
 * 2. `layer` is the axis users reason about when deciding what to lose:
 *    `dependencies` are re-installable, `build` outputs are rebuildable, `cache`
 *    only costs time, and `artifacts` may be irreplaceable.
 * 3. `risk` is the floor, not the verdict: the planner escalates a small-artifact
 *    rule to a higher risk when a single match is enormous, because deleting a
 *    multi-gigabyte directory is a different decision from deleting a 2 MB one.
 *
 * II. Why `reportOnly` exists
 *
 * 1. Some large directories look like caches but are not safely re-creatable by
 *    a generic tool — a Homebrew Cellar, Cargo's `src` checkout, a Docker image
 *    store. Reporting them lets the user see where the space went while making
 *    it explicit that DevEnvClean will not delete them.
 *
 * III. Extensibility contract
 *
 * 1. Adding an ecosystem means adding its `EcosystemDefinition` in `detector.ts`
 *    and its rules here — no engine changes. This is the promise `docs/design.md`
 *    section 12 makes.
 *
 * @module rules/builtin
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import type { CleanRule } from '../core/types.js';

/** Options every rule literal shares, kept terse to keep the catalog readable. */
type RuleInput = Partial<Omit<CleanRule, 'id' | 'label' | 'description' | 'layer' | 'kind' | 'patterns'>> & {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly layer: CleanRule['layer'];
  readonly kind: CleanRule['kind'];
  readonly patterns: readonly string[];
};

/**
 * Build a rule with every optional field defaulted.
 *
 * I. Defaults
 *
 * 1. Scope defaults to `project`, because machine-global caches are the
 *    exception and must be declared explicitly — a wrong `global` silently
 *    widens blast radius.
 * 2. Risk defaults to `low`, the safe assumption for something produced by a
 *    build or install step.
 * 3. `reportOnly` defaults to false; opting in is always deliberate.
 *
 * @param input - Rule fields with optional properties omitted.
 * @returns A fully-populated rule.
 */
function rule(input: RuleInput): CleanRule {
  return {
    scope: 'project',
    risk: 'low',
    withinEcosystem: null,
    minEntries: null,
    olderThanDays: null,
    reportOnly: false,
    note: null,
    ...input,
  };
}

/**
 * The complete built-in rule set.
 *
 * Ordering is the display order used by `dvc rules list` and by tie-broken
 * sorting in the TUI; the scanner itself is order-independent thanks to the
 * longest-path-wins deduplication in `engine.ts`.
 */
export const BUILTIN_RULES: readonly CleanRule[] = [
  // ===========================================================================
  // I. Node.js
  // ===========================================================================

  rule({
    id: 'node-modules',
    label: 'Node Dependencies',
    description:
      'Installed packages for a Node project. Re-creatable with npm/pnpm/yarn install, but the ' +
      'single largest consumer of disk on most front-end machines.',
    layer: 'dependencies',
    kind: 'node_modules',
    risk: 'low',
    patterns: ['**/node_modules'],
    withinEcosystem: ['node', 'bun', 'deno'],
    // Deliberately low. Scoped packages hoist into `node_modules/@scope/...`, so a
    // perfectly real dependency tree can hold only two or three top-level
    // entries; the size floor and the ecosystem detection are what actually
    // separate a real tree from noise, and this bound only rejects the empty
    // placeholder directories some tools leave behind.
    minEntries: 2,
    note: 're-installable',
  }),
  rule({
    id: 'node-next-cache',
    label: 'Next.js Build Cache',
    description: 'Incremental compiler output and image cache for Next.js. Re-created on the next build.',
    layer: 'cache',
    kind: 'cache',
    patterns: ['**/.next/cache'],
    withinEcosystem: ['node'],
    note: 'rebuilds on next dev/build',
  }),
  rule({
    id: 'node-next-output',
    label: 'Next.js Build Output',
    description: 'Production build output for Next.js. Rebuild with `next build`.',
    layer: 'build',
    kind: 'build',
    patterns: ['**/.next'],
    withinEcosystem: ['node'],
  }),
  rule({
    id: 'node-nuxt',
    label: 'Nuxt Build Output',
    description: 'Nuxt build and data directories. Re-created by `nuxt build` or `nuxt dev`.',
    layer: 'build',
    kind: 'build',
    patterns: ['**/.nuxt', '**/.output'],
    withinEcosystem: ['node'],
  }),
  rule({
    id: 'node-build-output',
    label: 'JS/TS Build Output',
    description: 'Compiled bundles and transpiled sources produced by a build step.',
    layer: 'build',
    kind: 'build',
    patterns: ['**/dist', '**/build', '**/out'],
    withinEcosystem: ['node', 'deno', 'bun'],
    note: 'never the source',
  }),
  rule({
    id: 'node-vite-cache',
    label: 'Vite / Turbopack Cache',
    description: 'Pre-bundled dependencies for the dev server. Re-created on next start.',
    layer: 'cache',
    kind: 'cache',
    patterns: ['**/node_modules/.vite', '**/.vite', '**/.turbo'],
    withinEcosystem: ['node'],
  }),
  rule({
    id: 'node-parcel-cache',
    label: 'Parcel Cache',
    description: 'Parcel transform cache. Safe to remove; the next build is simply slower.',
    layer: 'cache',
    kind: 'cache',
    patterns: ['**/.parcel-cache'],
    withinEcosystem: ['node'],
  }),
  rule({
    id: 'node-swc-cache',
    label: 'SWC / esbuild Cache',
    description: 'Transpiler caches used by SWC, esbuild and similar tools.',
    layer: 'cache',
    kind: 'cache',
    patterns: ['**/.swc', '**/.esbuild'],
    withinEcosystem: ['node'],
  }),
  rule({
    id: 'node-storybook',
    label: 'Storybook Output',
    description: 'Built Storybook static site. Rebuild with `build-storybook`.',
    layer: 'build',
    kind: 'build',
    patterns: ['**/storybook-static'],
    withinEcosystem: ['node'],
  }),
  rule({
    id: 'node-tests-cache',
    label: 'Test Coverage & Caches',
    description: 'Coverage reports and tool caches (Jest, Vitest, Playwright, Cypress).',
    layer: 'cache',
    kind: 'coverage',
    patterns: [
      '**/coverage',
      '**/.nyc_output',
      '**/test-results',
      '**/playwright-report',
      '**/cypress/videos',
      '**/cypress/screenshots',
    ],
  }),

  // ===========================================================================
  // II. Python
  // ===========================================================================

  rule({
    id: 'python-venv',
    label: 'Python Virtualenv',
    description:
      'An isolated Python environment. Re-creatable from requirements/lock files, but the exact ' +
      'resolved versions may drift if the lock file is not committed.',
    layer: 'dependencies',
    kind: 'venv',
    risk: 'medium',
    patterns: ['**/.venv', '**/venv', '**/env'],
    withinEcosystem: ['python'],
    note: 'check the lock file first',
  }),
  rule({
    id: 'python-pycache',
    label: 'Python Bytecode Cache',
    description: 'Compiled bytecode generated on import. Regenerated automatically.',
    layer: 'cache',
    kind: 'cache',
    risk: 'safe',
    patterns: ['**/__pycache__'],
    withinEcosystem: ['python'],
  }),
  rule({
    id: 'python-eggs',
    label: 'Python Packaging Artifacts',
    description: 'Build artifacts from legacy setuptools packaging: egg info, build and dist trees.',
    layer: 'artifacts',
    kind: 'artifacts',
    patterns: ['**/*.egg-info', '**/.eggs'],
    withinEcosystem: ['python'],
  }),
  rule({
    id: 'python-tox',
    label: 'Tox / Nox Environments',
    description: 'Per-interpreter test environments created by tox or nox.',
    layer: 'dependencies',
    kind: 'venv',
    patterns: ['**/.tox', '**/.nox'],
    withinEcosystem: ['python'],
  }),
  rule({
    id: 'python-pytest-cache',
    label: 'Pytest / Mypy Cache',
    description: 'Incremental analysis caches for pytest, mypy and ruff.',
    layer: 'cache',
    kind: 'cache',
    patterns: ['**/.pytest_cache', '**/.mypy_cache', '**/.ruff_cache', '**/.hypothesis'],
    withinEcosystem: ['python'],
  }),
  rule({
    id: 'python-ipynb-checkpoints',
    label: 'Jupyter Checkpoints',
    description: 'Notebook autosave checkpoints. The notebooks themselves are untouched.',
    layer: 'cache',
    kind: 'temp',
    patterns: ['**/.ipynb_checkpoints'],
  }),

  // ===========================================================================
  // III. Rust
  // ===========================================================================

  rule({
    id: 'rust-target',
    label: 'Rust Build Target',
    description:
      'Cargo build output including dependency object files. Rebuildable, but a cold rebuild of a ' +
      'large workspace can take tens of minutes.',
    layer: 'build',
    kind: 'build',
    risk: 'medium',
    patterns: ['**/target'],
    withinEcosystem: ['rust'],
    note: 'cold rebuild is slow',
  }),
  rule({
    id: 'rust-registry-cache',
    label: 'Cargo Registry Cache',
    description: 'Downloaded crate archives and extracted sources. Re-downloaded on demand.',
    layer: 'cache',
    kind: 'cache',
    patterns: ['**/.cargo/registry/cache', '**/.cargo/registry/src'],
    note: 're-downloadable',
  }),

  // ===========================================================================
  // IV. Go
  // ===========================================================================

  rule({
    id: 'go-build-cache',
    label: 'Go Build Cache',
    description: 'Compiled package artifacts. Re-populated by the next `go build`.',
    layer: 'cache',
    kind: 'cache',
    risk: 'safe',
    patterns: ['**/.cache/go-build'],
  }),
  rule({
    id: 'go-mod-cache',
    label: 'Go Module Cache',
    description: 'Downloaded module versions. Re-fetched from the module proxy on demand.',
    layer: 'dependencies',
    kind: 'cache',
    patterns: ['**/go/pkg/mod'],
    note: 're-downloadable',
  }),

  // ===========================================================================
  // V. JVM
  // ===========================================================================

  rule({
    id: 'java-gradle-project-cache',
    label: 'Gradle Project Cache',
    description: 'Per-project Gradle build cache and daemon metadata. Regenerated by the build.',
    layer: 'cache',
    kind: 'cache',
    patterns: ['**/.gradle'],
  }),
  rule({
    id: 'java-gradle-build',
    label: 'Gradle Build Output',
    description: 'Compiled classes and packaged jars from a Gradle build.',
    layer: 'build',
    kind: 'build',
    patterns: ['**/build/libs', '**/build/classes', '**/build/tmp'],
    withinEcosystem: ['java-gradle'],
  }),
  rule({
    id: 'java-gradle-global-cache',
    label: 'Gradle Global Caches',
    description: 'Machine-wide Gradle dependency and wrapper caches shared by all projects.',
    layer: 'cache',
    kind: 'cache',
    scope: 'global',
    patterns: ['**/.gradle/caches', '**/.gradle/wrapper/dists'],
    note: 'shared by all projects',
  }),
  rule({
    id: 'java-maven-repo',
    label: 'Maven Local Repository',
    description:
      'Every artifact Maven has ever downloaded. Very large, but deleting it forces a full ' +
      're-download and breaks offline builds.',
    layer: 'dependencies',
    kind: 'cache',
    risk: 'high',
    scope: 'global',
    patterns: ['**/.m2/repository'],
    note: 'offline builds will break',
  }),
  rule({
    id: 'java-target',
    label: 'JVM Build Output',
    description: 'Compiled output directories produced by Maven, Ant or an IDE.',
    layer: 'build',
    kind: 'build',
    patterns: ['**/target/classes', '**/target/test-classes', '**/target/generated-sources'],
  }),

  // ===========================================================================
  // VI. PHP, Ruby, .NET, Elixir, Swift, C/C++
  // ===========================================================================

  rule({
    id: 'php-vendor',
    label: 'PHP Vendor Dependencies',
    description: 'Composer-installed packages. Re-installable with `composer install`.',
    layer: 'dependencies',
    kind: 'vendor',
    patterns: ['**/vendor'],
    withinEcosystem: ['php'],
    minEntries: 10,
    note: 're-installable',
  }),
  rule({
    id: 'ruby-bundle',
    label: 'Ruby Bundle Path',
    description: 'Gems installed into the project by Bundler.',
    layer: 'dependencies',
    kind: 'vendor',
    patterns: ['**/vendor/bundle'],
    withinEcosystem: ['ruby'],
  }),
  rule({
    id: 'dotnet-build',
    label: '.NET Build Output',
    description: 'Intermediate and final .NET build directories.',
    layer: 'build',
    kind: 'build',
    patterns: ['**/bin/Debug', '**/bin/Release', '**/obj'],
    withinEcosystem: ['dotnet'],
  }),
  rule({
    id: 'elixir-deps',
    label: 'Elixir Dependencies',
    description: 'Hex packages fetched into the project. Re-fetchable with `mix deps.get`.',
    layer: 'dependencies',
    kind: 'vendor',
    patterns: ['**/deps'],
    withinEcosystem: ['elixir'],
    note: 're-fetchable',
  }),
  rule({
    id: 'elixir-build',
    label: 'Elixir Build Output',
    description: 'Compiled BEAM files produced by Mix.',
    layer: 'build',
    kind: 'build',
    patterns: ['**/_build'],
    withinEcosystem: ['elixir'],
  }),
  rule({
    id: 'swift-build',
    label: 'SwiftPM Build Directory',
    description: 'Swift Package Manager build output.',
    layer: 'build',
    kind: 'build',
    patterns: ['**/.build'],
    withinEcosystem: ['swift'],
  }),
  rule({
    id: 'cpp-build',
    label: 'CMake / Meson Build Tree',
    description: 'Out-of-source build directories for CMake and Meson projects.',
    layer: 'build',
    kind: 'build',
    patterns: ['**/build/CMakeFiles', '**/cmake-build-debug', '**/cmake-build-release'],
    withinEcosystem: ['c-cpp'],
  }),

  // ===========================================================================
  // VII. Generic project-local caches and temporary output
  // ===========================================================================

  rule({
    id: 'generic-cache',
    label: 'Project Cache Directory',
    description: 'Tool caches placed in the conventional project-local cache location.',
    layer: 'cache',
    kind: 'cache',
    risk: 'safe',
    patterns: ['**/.cache'],
  }),
  rule({
    id: 'generic-logs',
    label: 'Project Log Files',
    description:
      'Application and build logs written into the project, and log directories that only ever accumulate.',
    layer: 'cache',
    kind: 'logs',
    patterns: ['**/logs', '**/*.log'],
  }),
  rule({
    id: 'generic-tmp',
    label: 'Temporary Output',
    description: 'Scratch directories that tools recreate on demand.',
    layer: 'cache',
    kind: 'temp',
    risk: 'safe',
    patterns: ['**/.tmp', '**/.temp', '**/tmp/cache'],
  }),

  // ===========================================================================
  // VIII. Machine-global package-manager caches
  // ===========================================================================

  rule({
    id: 'global-npm-cache',
    label: 'npm Cache',
    description:
      'npm content-addressable cache. Re-downloads on demand; `npm cache verify` reports its health.',
    layer: 'cache',
    kind: 'cache',
    scope: 'global',
    patterns: ['**/.npm/_cacache'],
    note: 're-downloadable',
  }),
  rule({
    id: 'global-pnpm-store',
    label: 'pnpm Content Store',
    description:
      'Content-addressable store shared by every pnpm project. Deleting it unbinds every installed ' +
      'node_modules from its hard links and forces re-installation everywhere.',
    layer: 'dependencies',
    kind: 'cache',
    risk: 'high',
    scope: 'global',
    patterns: ['**/pnpm/store', '**/Library/Caches/pnpm', '**/.local/share/pnpm/store'],
    note: 'breaks existing node_modules links',
  }),
  rule({
    id: 'global-yarn-cache',
    label: 'Yarn Cache',
    description: 'Yarn package archives, both classic and Berry.',
    layer: 'cache',
    kind: 'cache',
    scope: 'global',
    patterns: ['**/Library/Caches/Yarn', '**/.cache/yarn', '**/AppData/Local/Yarn/Cache'],
  }),
  rule({
    id: 'global-pip-cache',
    label: 'pip Download Cache',
    description: 'Wheels and sdists downloaded by pip.',
    layer: 'cache',
    kind: 'cache',
    scope: 'global',
    patterns: ['**/Library/Caches/pip', '**/.cache/pip'],
  }),
  rule({
    id: 'global-uv-cache',
    label: 'uv Cache',
    description: 'Package cache maintained by the uv resolver.',
    layer: 'cache',
    kind: 'cache',
    scope: 'global',
    patterns: ['**/Library/Caches/uv', '**/.cache/uv', '**/AppData/Local/uv/cache'],
  }),
  rule({
    id: 'global-xcode-derived-data',
    label: 'Xcode DerivedData',
    description:
      'Xcode build intermediates and indexes. Regenerated on the next build; deleting it also clears ' +
      'code completion indexes, which reappear as Xcode re-indexes.',
    layer: 'build',
    kind: 'build',
    risk: 'medium',
    scope: 'global',
    patterns: ['**/Library/Developer/Xcode/DerivedData'],
    note: 'Xcode re-indexes on next open',
  }),
  rule({
    id: 'global-xcode-archives',
    label: 'Xcode Archives',
    description:
      'Archived app builds used for App Store submission. Deleting them can break re-uploading an existing version.',
    layer: 'artifacts',
    kind: 'artifacts',
    risk: 'high',
    scope: 'global',
    patterns: ['**/Library/Developer/Xcode/Archives'],
    reportOnly: true,
    note: 'report only: cannot be rebuilt',
  }),
  rule({
    id: 'global-cocoapods',
    label: 'CocoaPods Cache',
    description: 'Downloaded pod specifications and sources.',
    layer: 'cache',
    kind: 'cache',
    scope: 'global',
    patterns: ['**/Library/Caches/CocoaPods'],
  }),
  rule({
    id: 'global-homebrew-cache',
    label: 'Homebrew Download Cache',
    description:
      'Bottles and source tarballs downloaded by Homebrew. Safe to remove; re-downloaded if needed.',
    layer: 'cache',
    kind: 'cache',
    risk: 'safe',
    scope: 'global',
    patterns: ['**/Library/Caches/Homebrew', '**/.cache/Homebrew'],
  }),
  rule({
    id: 'global-docker-report',
    label: 'Docker Data (report only)',
    description:
      'The Docker image and container store. Frequently the largest consumer on a developer machine, ' +
      'but it must be reclaimed with `docker system prune`, never by deleting files.',
    layer: 'artifacts',
    kind: 'artifacts',
    risk: 'high',
    scope: 'global',
    patterns: ['**/Library/Containers/com.docker.docker/Data/vms', '**/docker/overlay2'],
    reportOnly: true,
    note: 'use `docker system prune`',
  }),
];

/**
 * Index the catalog by rule id for O(1) override lookup.
 *
 * @returns A map from rule id to rule.
 */
export function indexRules(): Map<string, CleanRule> {
  return new Map(BUILTIN_RULES.map((entry) => [entry.id, entry]));
}

/** Total number of built-in rules, surfaced by `dvc rules list` and the tests. */
export const BUILTIN_RULE_COUNT = BUILTIN_RULES.length;
