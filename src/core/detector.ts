/**
 * Ecosystem Detection
 *
 * Recognises development-project roots from their marker files and reports
 * which toolchains a directory belongs to.
 *
 * I. Detection model
 *
 * 1. Detection is *entry-driven*, not probe-driven: the scanner already holds
 *    one `readdir` result per directory, so the detector only inspects that
 *    name set. This keeps detection free of extra syscalls, which matters when
 *    a scan walks a hundred thousand directories.
 * 2. A directory may belong to several ecosystems at once (a Rust project with
 *    a Node-based docs site), so the result is a set, never a single winner.
 * 3. Package-manager detection is deliberately a *separate*, optional step that
 *    reads at most one small file, so the hot path stays metadata-only.
 *
 * II. Why the catalog is data
 *
 * 1. Adding an ecosystem means appending one catalog entry plus its rules; no
 *    control flow changes, which is the extensibility promise in `docs/design.md`.
 *
 * @module core/detector
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

/** A marker file that identifies an ecosystem when it sits in a directory. */
export interface MarkerDefinition {
  /** File or directory name to look for, compared exactly. */
  readonly marker: string;
  /** Ecosystem id this marker implies. */
  readonly ecosystem: EcosystemId;
  /**
   * When true the marker is only a weak hint for a monorepo-level tool and does
   * not by itself make the directory a project root. Weak markers (a lock file
   * with no manifest) still count once another strong marker matches.
   */
  readonly weak?: boolean;
}

/** Ecosystem identifiers understood by the detector. */
export type EcosystemId =
  | 'node'
  | 'deno'
  | 'bun'
  | 'python'
  | 'rust'
  | 'go'
  | 'java-maven'
  | 'java-gradle'
  | 'php'
  | 'ruby'
  | 'dotnet'
  | 'elixir'
  | 'swift'
  | 'c-cpp';

/** Static description of one ecosystem, used by summaries and `dvc rules list`. */
export interface EcosystemDefinition {
  /** Stable id referenced by rules and config. */
  readonly id: EcosystemId;
  /** Display name. */
  readonly name: string;
  /** Marker files that identify the ecosystem. */
  readonly markers: readonly MarkerDefinition[];
  /** Primary language label, shown next to the project name in the TUI. */
  readonly language: string;
}

/**
 * The full marker catalog.
 *
 * Order matters only for deterministic output: the detector reports ecosystems
 * in catalog order so two scans of the same tree produce byte-identical JSON.
 */
export const ECOSYSTEMS: readonly EcosystemDefinition[] = [
  {
    id: 'node',
    name: 'Node.js',
    language: 'JavaScript / TypeScript',
    markers: [
      { marker: 'package.json', ecosystem: 'node' },
      { marker: 'pnpm-workspace.yaml', ecosystem: 'node' },
      { marker: 'lerna.json', ecosystem: 'node', weak: true },
      { marker: 'nx.json', ecosystem: 'node', weak: true },
      { marker: 'turbo.json', ecosystem: 'node', weak: true },
    ],
  },
  {
    id: 'deno',
    name: 'Deno',
    language: 'TypeScript',
    markers: [
      { marker: 'deno.json', ecosystem: 'deno' },
      { marker: 'deno.jsonc', ecosystem: 'deno' },
    ],
  },
  {
    id: 'bun',
    name: 'Bun',
    language: 'JavaScript / TypeScript',
    markers: [
      { marker: 'bun.lockb', ecosystem: 'bun' },
      { marker: 'bun.lock', ecosystem: 'bun' },
    ],
  },
  {
    id: 'python',
    name: 'Python',
    language: 'Python',
    markers: [
      { marker: 'pyproject.toml', ecosystem: 'python' },
      { marker: 'requirements.txt', ecosystem: 'python' },
      { marker: 'setup.py', ecosystem: 'python' },
      { marker: 'Pipfile', ecosystem: 'python' },
      { marker: 'poetry.lock', ecosystem: 'python', weak: true },
      { marker: 'uv.lock', ecosystem: 'python', weak: true },
      { marker: 'conda.yml', ecosystem: 'python', weak: true },
    ],
  },
  {
    id: 'rust',
    name: 'Rust',
    language: 'Rust',
    markers: [{ marker: 'Cargo.toml', ecosystem: 'rust' }],
  },
  {
    id: 'go',
    name: 'Go',
    language: 'Go',
    markers: [
      { marker: 'go.mod', ecosystem: 'go' },
      { marker: 'go.sum', ecosystem: 'go', weak: true },
    ],
  },
  {
    id: 'java-maven',
    name: 'Java (Maven)',
    language: 'Java / Kotlin',
    markers: [{ marker: 'pom.xml', ecosystem: 'java-maven' }],
  },
  {
    id: 'java-gradle',
    name: 'Java (Gradle)',
    language: 'Java / Kotlin / Groovy',
    markers: [
      { marker: 'build.gradle', ecosystem: 'java-gradle' },
      { marker: 'build.gradle.kts', ecosystem: 'java-gradle' },
      { marker: 'settings.gradle', ecosystem: 'java-gradle', weak: true },
      { marker: 'settings.gradle.kts', ecosystem: 'java-gradle', weak: true },
    ],
  },
  {
    id: 'php',
    name: 'PHP',
    language: 'PHP',
    markers: [{ marker: 'composer.json', ecosystem: 'php' }],
  },
  {
    id: 'ruby',
    name: 'Ruby',
    language: 'Ruby',
    markers: [
      { marker: 'Gemfile', ecosystem: 'ruby' },
      { marker: 'gems.rb', ecosystem: 'ruby' },
    ],
  },
  {
    id: 'dotnet',
    name: '.NET',
    language: 'C# / F#',
    markers: [
      { marker: 'global.json', ecosystem: 'dotnet', weak: true },
      { marker: 'packages.config', ecosystem: 'dotnet' },
    ],
  },
  {
    id: 'elixir',
    name: 'Elixir',
    language: 'Elixir',
    markers: [{ marker: 'mix.exs', ecosystem: 'elixir' }],
  },
  {
    id: 'swift',
    name: 'Swift',
    language: 'Swift',
    markers: [{ marker: 'Package.swift', ecosystem: 'swift' }],
  },
  {
    id: 'c-cpp',
    name: 'C / C++',
    language: 'C / C++',
    markers: [
      { marker: 'CMakeLists.txt', ecosystem: 'c-cpp' },
      { marker: 'meson.build', ecosystem: 'c-cpp' },
    ],
  },
];

/**
 * Flat, name-keyed lookup used on the hot path.
 *
 * Several ecosystems may share a marker family, so the value is a list rather
 * than a single ecosystem.
 */
const MARKER_INDEX: ReadonlyMap<string, readonly MarkerDefinition[]> = (() => {
  const index = new Map<string, MarkerDefinition[]>();
  for (const ecosystem of ECOSYSTEMS) {
    for (const marker of ecosystem.markers) {
      const existing = index.get(marker.marker);
      if (existing) existing.push(marker);
      else index.set(marker.marker, [marker]);
    }
  }
  return index;
})();

/** Result of inspecting one directory for project markers. */
export interface DetectionResult {
  /** True when at least one strong marker was found. */
  readonly isProjectRoot: boolean;
  /** Ecosystem ids found, in catalog order and deduplicated. */
  readonly ecosystems: readonly EcosystemId[];
  /** Marker file names that matched, sorted for deterministic output. */
  readonly markers: readonly string[];
  /**
   * Package manager inferred from lock files, or null when unknown. Only
   * populated for Node projects, where the distinction changes which cache the
   * user should be pointed at.
   */
  readonly packageManager: NodePackageManager | null;
}

/** Node package managers DevEnvClean recognises by lock file. */
export type NodePackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Lock file names mapped to the manager that owns them. */
const NODE_LOCKFILES: ReadonlyArray<readonly [string, NodePackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/**
 * Inspect a directory's entry names for project markers.
 *
 * I. Algorithm
 *
 * 1. Walk the entry list once and collect every marker hit from the index.
 * 2. Partition hits into strong and weak; only strong hits make the directory a
 *    project root, but a strong hit admits the weak ecosystems found alongside.
 * 3. Emit ecosystems in catalog order so output is stable across runs.
 *
 * @param entryNames - Names present in the directory (files and folders).
 * @param options - Detection options.
 * @param options.enabledEcosystems - Optional allow-list of ecosystem ids.
 * @returns The detection result; `isProjectRoot` is false when nothing matched.
 *
 * @example
 * ```ts
 * detectInEntries(['package.json', 'pnpm-lock.yaml'])
 * // { isProjectRoot: true, ecosystems: ['node'], markers: [...],
 * //   packageManager: 'pnpm' }
 * ```
 */
export function detectInEntries(
  entryNames: readonly string[],
  options: { enabledEcosystems?: readonly EcosystemId[] } = {},
): DetectionResult {
  const allowed = options.enabledEcosystems ? new Set(options.enabledEcosystems) : null;
  const strong = new Set<EcosystemId>();
  const weak = new Set<EcosystemId>();
  const markers: string[] = [];

  // I. Single pass over the directory entries for project markers.
  const present = new Set(entryNames);
  for (const name of present) {
    const definitions = MARKER_INDEX.get(name);
    if (!definitions) continue;
    for (const definition of definitions) {
      if (allowed && !allowed.has(definition.ecosystem)) continue;
      markers.push(name);
      if (definition.weak) weak.add(definition.ecosystem);
      else strong.add(definition.ecosystem);
    }
  }

  // II. Package-manager inference runs over the *catalog* order, not the entry
  //     order. Reading the entries first would make the answer depend on the
  //     filesystem's readdir order, so a directory holding both `pnpm-lock.yaml`
  //     and `yarn.lock` would report pnpm on one machine and yarn on another —
  //     the same tree, two different answers, for no reason. The catalog is
  //     ordered most-specific-first, and that order is the tie-break.
  let packageManager: NodePackageManager | null = null;
  if (!allowed || allowed.has('node')) {
    for (const [lockfile, manager] of NODE_LOCKFILES) {
      if (!present.has(lockfile)) continue;
      packageManager = manager;
      break;
    }
  }

  // III. Strong markers establish the root; weak ones join only alongside them.
  const ecosystems = ECOSYSTEMS.map((ecosystem) => ecosystem.id).filter(
    (id) => strong.has(id) || (weak.has(id) && strong.size > 0),
  );

  return {
    isProjectRoot: strong.size > 0,
    ecosystems,
    markers: markers.sort(),
    packageManager,
  };
}

/**
 * Look up an ecosystem definition by id.
 *
 * @param id - Ecosystem id.
 * @returns The definition, or undefined when the id is unknown.
 */
export function getEcosystem(id: EcosystemId): EcosystemDefinition | undefined {
  return ECOSYSTEMS.find((ecosystem) => ecosystem.id === id);
}

/**
 * Human-readable name for an ecosystem id.
 *
 * @param id - Ecosystem id.
 * @returns The display name, falling back to the raw id.
 */
export function ecosystemName(id: string): string {
  return ECOSYSTEMS.find((ecosystem) => ecosystem.id === id)?.name ?? id;
}

/**
 * Every marker file name in the catalog.
 *
 * The scanner uses this to decide which `package.json` files are worth parsing
 * for a workspace declaration, without a second directory read.
 */
export const ALL_MARKER_NAMES: readonly string[] = [...MARKER_INDEX.keys()].sort();
