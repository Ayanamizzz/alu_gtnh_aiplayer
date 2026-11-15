#!/usr/bin/env node
/**
 * Reproducible, local-only build (Node 24). No installation or download here.
 * Prepare a separate tools directory with the committed toolchain/package-lock.json:
 *   npm ci --prefix /tmp/planner-tools --ignore-scripts
 *   node brain/vendor/gtnh-planner/generate.mjs --tools /tmp/planner-tools
 * To refresh the exact source closure, additionally pass --upstream /path/to/clone.
 * The clone must be clean and pinned to SOURCE_COMMIT; it is never modified.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const SOURCE_COMMIT = 'e493e36a64d5a226e6110fab8a765ae08c3bf7c5';
const MOD_COMMIT = '69dd09fe21117d7b8558625dc9556723873942ca';
const VERSIONS = { esbuild: '0.28.2', highs: '1.15.2', zod: '4.4.3' };
const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
const tools = option('--tools');
if (!tools) throw new Error('Pass --tools /absolute/path/to/isolated-toolchain (esbuild 0.28.2, highs 1.15.2, zod 4.4.3).');
const modules = resolve(tools, 'node_modules');
for (const [name, version] of Object.entries(VERSIONS)) {
  const pkg = JSON.parse(await readFile(join(modules, name, 'package.json'), 'utf8'));
  if (pkg.version !== version || pkg.license !== 'MIT') throw new Error(`Expected ${name}@${version}, MIT.`);
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mod = option('--mod');
if (mod) {
  if (execFileSync('git', ['-C', mod, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== MOD_COMMIT) throw new Error('Wrong mod commit.');
  if (execFileSync('git', ['-C', mod, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('Mod tracked files must be clean.');
  await mkdir(join(root, 'mod'), { recursive: true });
  await cp(join(mod, 'src/main/resources/assets/gtnhplanner/machines/handlers.json'), join(root, 'mod/handlers.json'));
  await cp(join(mod, 'LICENSE'), join(root, 'mod/LICENSE'));
  const hashes = {};
  for (const file of ['mod/handlers.json', 'mod/LICENSE']) hashes[file] = hash(await readFile(join(root, file)));
  await writeFile(join(root, 'mod-files.json'), JSON.stringify(hashes, null, 2) + '\n');
}
const upstream = option('--upstream');
const snapshot = join(root, 'upstream');
const entries = [
  'src/lib/solver/throughput.ts', 'src/lib/model/schemas.ts', 'src/lib/solver/plan/solve-plan.ts',
  'src/lib/solver/plan/__fixtures__/digest.ts', 'src/lib/solver/plan/__fixtures__/compare.ts',
  'src/lib/solver/plan/__fixtures__/load.ts', 'src/lib/model/edge-identity.ts',
];
const sourceFiles = {};
if (upstream) {
  if (execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== SOURCE_COMMIT) throw new Error('Wrong upstream commit.');
  if (execFileSync('git', ['-C', upstream, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('Upstream tracked files must be clean.');
  const pending = [...entries];
  while (pending.length) {
    const file = pending.pop();
    if (sourceFiles[file]) continue;
    const bytes = await readFile(join(upstream, file));
    sourceFiles[file] = hash(bytes);
    if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      const text = bytes.toString('utf8');
      const imports = [...text.matchAll(/\b(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
      for (const specifier of imports) {
        if (!specifier.startsWith('.') && !specifier.startsWith('@/')) continue;
        const base = specifier.startsWith('@/') ? join('src', specifier.slice(2)) : join(dirname(file), specifier);
        const dependency = [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, join(base, 'index.ts')].find((candidate) => existsSync(join(upstream, candidate)) && /\.(?:ts|tsx|json)$/.test(candidate));
        if (!dependency) throw new Error(`Unresolved ${specifier} from ${file}`);
        pending.push(dependency);
      }
    }
  }
  // Corpus data and the original license are verbatim, not generated expected values.
  const corpus = 'src/lib/solver/plan/__fixtures__/corpus';
  for (const sub of ['inputs', 'goldens']) {
    for (const file of await readdir(join(upstream, corpus, sub))) {
      const path = join(corpus, sub, file);
      sourceFiles[path] = hash(await readFile(join(upstream, path)));
    }
  }
  sourceFiles.LICENSE = hash(await readFile(join(upstream, 'LICENSE')));
  await rm(snapshot, { recursive: true, force: true });
  for (const file of Object.keys(sourceFiles).sort()) {
    await mkdir(dirname(join(snapshot, file)), { recursive: true });
    await cp(join(upstream, file), join(snapshot, file));
  }
  await writeFile(join(root, 'source-files.json'), JSON.stringify(Object.fromEntries(Object.entries(sourceFiles).sort()), null, 2) + '\n');
} else {
  Object.assign(sourceFiles, JSON.parse(await readFile(join(root, 'source-files.json'), 'utf8')));
}
for (const [file, expected] of Object.entries(sourceFiles)) {
  if (hash(await readFile(join(snapshot, file))) !== expected) throw new Error(`Source hash mismatch: ${file}`);
}

for (const [file, expected] of Object.entries(JSON.parse(await readFile(join(root, 'mod-files.json'), 'utf8')))) {
  if (hash(await readFile(join(root, file))) !== expected) throw new Error(`Mod hash mismatch: ${file}`);
}

const patches = JSON.parse(await readFile(join(root, 'lp-observability.json'), 'utf8'));
const esbuild = await import(pathToFileURL(join(modules, 'esbuild/lib/main.js')).href);
await mkdir(join(root, 'dist'), { recursive: true });
const common = {
  absWorkingDir: root, bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  minify: false, legalComments: 'inline', charset: 'utf8', metafile: true,
  nodePaths: [modules], alias: { '@': join(snapshot, 'src') },
  plugins: [{ name: 'observable-upstream-lp', setup(build) {
    build.onLoad({ filter: /\/solver\/lp-engine\.ts$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      for (const patch of patches) {
        if (contents.split(patch.old).length !== 2) throw new Error(`Observability patch must match exactly once: ${patch.old}`);
        contents = contents.replace(patch.old, patch.new);
      }
      return { contents, loader: 'ts', resolveDir: dirname(path) };
    });
  } }],
};
const result = await esbuild.build({ ...common, entryPoints: ['runtime-entry.ts'], outfile: 'dist/runtime.cjs' });
await esbuild.build({ ...common, entryPoints: ['test-entry.ts'], outfile: 'dist/test-support.cjs' });
await esbuild.build({ ...common, format: 'esm', entryPoints: ['catalog-entry.ts'], outfile: 'dist/catalog.mjs' });
await mkdir(join(root, 'types'), { recursive: true });
const modelTypes = (await readFile(join(snapshot, 'src/lib/model/types.ts'), 'utf8'))
  .replace('"@/lib/solver/plan/types"', '"./plan-types.js"')
  .replace(/export const (PROJECT_SCHEMA_VERSION|TICKS_PER_SECOND) = (\d+);/g, 'export declare const $1: $2;');
await writeFile(join(root, 'types/model.d.ts'), modelTypes);
await cp(join(snapshot, 'src/lib/solver/plan/types.ts'), join(root, 'types/plan-types.d.ts'));
const machineTable = await readFile(join(snapshot, 'src/lib/machines/machine-table.ts'), 'utf8');
const behaviourTypes = 'import type { MachineConfigControl, Recipe } from "./model.js";\n'
  + machineTable.slice(machineTable.indexOf('export interface OverclockRule'), machineTable.indexOf('export const OVERCLOCK'))
  + 'export declare const HEAT_OVERCLOCK: "heat";\n'
  + machineTable.slice(machineTable.indexOf('export type OverclockSpec'), machineTable.indexOf('export function resolveCoefficient'));
await writeFile(join(root, 'types/machine-behaviour.d.ts'), behaviourTypes);
// esbuild uses installation-relative module labels in comments/CJS wrapper keys.
// Normalize those labels so changing the isolated tools directory changes no bytes.
const packagePrefix = relative(root, modules).replaceAll('\\', '/') + '/';
for (const file of ['dist/runtime.cjs', 'dist/test-support.cjs', 'dist/catalog.mjs']) {
  const text = await readFile(join(root, file), 'utf8');
  await writeFile(join(root, file), text.replaceAll(packagePrefix, 'node_modules/'));
}
await cp(join(modules, 'highs/build/highs.wasm'), join(root, 'dist/highs.wasm'));
await mkdir(join(root, 'licenses'), { recursive: true });
await cp(join(snapshot, 'LICENSE'), join(root, 'licenses/gtnh-factory-flow-MIT.txt'));
for (const name of Object.keys(VERSIONS)) {
  const license = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].find((file) => existsSync(join(modules, name, file)));
  if (!license) throw new Error(`Missing ${name} license`);
  await cp(join(modules, name, license), join(root, `licenses/${name}-MIT.txt`));
}
const outputHashes = {};
for (const file of ['dist/runtime.cjs', 'dist/test-support.cjs', 'dist/catalog.mjs', 'dist/highs.wasm', 'types/model.d.ts', 'types/plan-types.d.ts', 'types/machine-behaviour.d.ts']) outputHashes[file] = hash(await readFile(join(root, file)));
const provenance = {
  upstream: { url: 'https://github.com/jackwrichards/gtnh-factory-flow', commit: SOURCE_COMMIT, license: 'MIT', copyright: ['2026 Samiracle64', '2026 jackwrichards'] },
  referenceMod: { url: 'https://github.com/jackwrichards/gtnh-planner-mod', commit: MOD_COMMIT, license: 'MIT', copyright: ['2026 Sbancuz'], purpose: 'Independent machine-math comparison and common solver corpus; not a runtime dependency.' },
  packages: { esbuild: { version: VERSIONS.esbuild, role: 'build only', license: 'MIT' }, highs: { version: VERSIONS.highs, role: 'bundled runtime JS and WASM', license: 'MIT' }, zod: { version: VERSIONS.zod, role: 'bundled runtime validation', license: 'MIT' } },
  runtime: ['dist/runtime.cjs', 'dist/catalog.mjs', 'dist/highs.wasm', 'mod/handlers.json'],
  modifications: ['Upstream snapshots are byte-identical. Build-time lp-observability.json adds call counters and bounded failure messages; no mathematical changes.', 'Project-owned runtime-entry.ts adds upstream schema validation, reserved/duplicate identifier checks, and raw SolveInputJson validation.', 'Node worker requires HiGHS to initialize, supplies an import.meta.url-relative WASM path, and never fetches assets.', 'types/model.d.ts converts the two numeric constants into ambient declarations and rewrites the sole type import to ./plan-types.js; types/plan-types.d.ts is verbatim upstream.'],
  build: { command: 'node brain/vendor/gtnh-planner/generate.mjs --tools /path/to/isolated-toolchain', lockfile: 'toolchain/package-lock.json', sourceHashes: 'source-files.json', outputHashes },
  runtimeInputs: Object.keys(result.metafile.inputs).map((file) => file.includes('node_modules/') ? file.slice(file.lastIndexOf('node_modules/')) : file).sort(),
};
await writeFile(join(root, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(`Vendored ${Object.keys(sourceFiles).length} source/data files. Runtime: ${Object.keys(result.metafile.inputs).length} inputs.\n${JSON.stringify(outputHashes, null, 2)}`);
