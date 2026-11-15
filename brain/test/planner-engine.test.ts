import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { PlannerEngine, PlannerEngineError, checkPlannerInput } from '../src/planner/engine.ts';
import type { FactoryProject, Recipe, FactoryNode, ThroughputResult } from '../vendor/gtnh-planner/types/model.js';
import type { Answer, SolveInput } from '../vendor/gtnh-planner/types/plan-types.js';
import { applyMachineHandlerToRecipe, getMachineParallelMultiplier, getOverclockedRecipeStats } from '../vendor/gtnh-planner/dist/catalog.mjs';
import { chain, node, project, recipe, storage, wire } from './planner-engine-fixtures.ts';

const vendor = new URL('../vendor/gtnh-planner/', import.meta.url);
const corpus = new URL('upstream/src/lib/solver/plan/__fixtures__/corpus/', vendor);
const json = async (url: URL): Promise<unknown> => JSON.parse(await readFile(url, 'utf8')) as unknown;
const support = createRequire(import.meta.url)('../vendor/gtnh-planner/dist/test-support.cjs') as {
  digest(answer: unknown): { solution: Record<string, unknown>; alternatives: Record<string, unknown> };
  differences(expected: unknown, actual: unknown): string[];
  parseSolveInput(raw: unknown): SolveInput;
  tile(input: SolveInput, copies: number): SolveInput;
};
function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}
function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof PlannerEngineError && error.code === code;
}
async function calculate(engine: PlannerEngine, input: FactoryProject): Promise<ThroughputResult> {
  return await engine.calculate(input) as ThroughputResult;
}
async function heavyInput(): Promise<SolveInput> {
  return support.tile(support.parseSolveInput(await json(new URL('inputs/platline.json', corpus))), 10);
}

test('native project calculates the whole chain, external ore, power and immutable per-request receipts', async () => {
  const engine = new PlannerEngine();
  try {
    const input = chain();
    const before = JSON.stringify(input);
    const [first, second] = await Promise.all([engine.calculateDetailed(input), engine.calculateDetailed(input)]);
    const report = first.result as ThroughputResult;
    assert.equal(JSON.stringify(input), before);
    near(report.nodes.crush.theoreticalMachinesRequired, 3);
    near(report.nodes.press.theoreticalMachinesRequired, 3);
    near(report.edges.middle.transferredPerSecond, 3);
    near(report.storages.ore.consumedPerSecond, 1.5);
    near(report.storages.plate.producedPerSecond, 3);
    near(report.totalEuT, 48);
    assert.deepEqual(report.plan?.forced, []);
    assert.deepEqual(report.plan?.unmetDrawers, []);
    assert.equal(first.run.diagnostics?.backend, 'highs');
    assert.ok(first.run.diagnostics!.highsCalls > 0);
    assert.equal(first.run.diagnostics?.simplexCalls, 0);
    assert.deepEqual(first.run.diagnostics?.fallbackErrors, []);
    const provenance = await json(new URL('provenance.json', vendor)) as { build: { outputHashes: Record<string, string> } };
    assert.equal(first.run.diagnostics?.runtimeSha256, provenance.build.outputHashes['dist/runtime.cjs']);
    assert.equal(first.run.diagnostics?.wasmSha256, provenance.build.outputHashes['dist/highs.wasm']);
    assert.notEqual(first.run.id, second.run.id);
    assert.ok(Object.isFrozen(first.run));
    assert.deepEqual(JSON.parse(JSON.stringify(first.run)), first.run);
    assert.equal(first.run.inputSha256, createHash('sha256').update(before).digest('hex'));
    assert.equal(first.run.inputBytes, Buffer.byteLength(before));
    assert.equal(engine.info().lastRun?.id, second.run.id);
    assert.deepEqual(first.result, second.result);
  } finally { await engine.close(); }
});

test('recycling loop returns its catalyst internally instead of buying a fresh catalyst each craft', async () => {
  const engine = new PlannerEngine();
  try {
    const report = await calculate(engine, project({
      recipes: [recipe('a', [['ore', 1], ['catalyst', 1]], [['intermediate', 2]]), recipe('b', [['intermediate', 2]], [['catalyst', 1], ['plate', 1]])],
      nodes: [node('a', 'a'), node('b', 'b')],
      storages: [storage('ore', 'ore'), storage('plate', 'plate', { targetPerSecond: 3, targetMode: 'exact' })],
      edges: [wire('in', 'ore', 'a', 'ore'), wire('forward', 'a', 'b', 'intermediate'), wire('return', 'b', 'a', 'catalyst'), wire('out', 'b', 'plate', 'plate')],
    }));
    near(report.edges.forward.transferredPerSecond, 6);
    near(report.edges.return.transferredPerSecond, 3);
    near(report.nodes.a.theoreticalMachinesRequired, 3);
    near(report.nodes.b.theoreticalMachinesRequired, 3);
    near(report.resources['item:catalyst'].netPerSecond, 0);
    assert.deepEqual(report.plan?.forced, []);
    assert.deepEqual(report.externalInputs.map((entry) => entry.resourceId), ['ore']);
  } finally { await engine.close(); }
});

test('chance outputs, byproducts and nonconsumed tooling keep their native expected-rate semantics', async () => {
  const engine = new PlannerEngine();
  try {
    const report = await calculate(engine, project({
      recipes: [recipe('separate', [['ore', 1]], [['product', 2], ['waste', 3]], {
        inputs: [{ kind: 'item', id: 'ore', amount: 1 }, { kind: 'item', id: 'mold', amount: 1, consumed: false }],
        outputs: [{ kind: 'item', id: 'product', amount: 2, chance: 0.5 }, { kind: 'item', id: 'waste', amount: 3 }],
      })],
      nodes: [node('separate', 'separate')],
      storages: [storage('ore', 'ore'), storage('product', 'product', { targetPerSecond: 1.5, targetMode: 'exact' }), storage('waste', 'waste', { drainMode: 'byproduct' })],
      edges: [wire('in', 'ore', 'separate', 'ore'), wire('product', 'separate', 'product', 'product'), wire('waste', 'separate', 'waste', 'waste')],
    }));
    near(report.nodes.separate.theoreticalMachinesRequired, 1.5);
    near(report.storages.product.producedPerSecond, 1.5);
    near(report.storages.waste.producedPerSecond, 4.5);
    near(report.resources['item:waste'].byproductPerSecond ?? -1, 4.5);
    assert.equal(report.nodes.separate.inputs['item:mold'], undefined);
    // The native engine returns fractional load. The caller can then explain two physical machines.
    assert.equal(Math.ceil(report.nodes.separate.theoreticalMachinesRequired), 2);
  } finally { await engine.close(); }
});

test('two shared recipes use one total machine-time pool, not one whole machine per section', async () => {
  const engine = new PlannerEngine();
  try {
    const report = await calculate(engine, project({
      recipes: [recipe('a', [['x', 1]], [['y', 1]]), recipe('b', [['y', 1]], [['z', 1]])],
      nodes: [node('card', 'a', { extraRecipes: [{ recipeId: 'b' }], solvePin: 1 })],
      storages: [storage('in', 'x'), storage('out', 'z', { targetPerSecond: 0.5, targetMode: 'exact' })],
      edges: [wire('in', 'in', 'card', 'x'), wire('ab', 'card', 'card', 'y', { sourceHandle: 'output:item:y', targetHandle: 'r1:input:item:y' }), wire('out', 'card', 'out', 'z', { sourceHandle: 'r1:output:item:z' })],
    }));
    near(report.nodes.card.theoreticalMachinesRequired, 0.5);
    near(report.nodes['card#r1'].theoreticalMachinesRequired, 0.5);
    near(report.plan!.upTo!.card.reached, 1);
    near(report.storages.out.producedPerSecond, 0.5);
    assert.deepEqual(report.plan?.forced, []);
  } finally { await engine.close(); }
});

test('a machine cap cannot be hidden by a larger product goal; source caps disclose forced replacement imports', async () => {
  const engine = new PlannerEngine();
  try {
    const limited = chain();
    limited.nodes[0].solvePin = 1;
    const report = await calculate(engine, limited);
    near(report.nodes.crush.theoreticalMachinesRequired, 1);
    near(report.storages.plate.producedPerSecond, 1);
    assert.deepEqual(report.plan?.unmetDrawers, ['plate']);
    near(report.plan!.shortfalls![0].target, 3);
    near(report.plan!.shortfalls![0].reachable, 1);
    assert.equal(report.storages.plate.targetUnreachable, true);

    const supply = chain();
    supply.storages![0].targetPerSecond = 0.5;
    supply.storages![0].targetMode = 'at-most';
    const supplied = await calculate(engine, supply);
    near(supplied.storages.ore.consumedPerSecond, 0.5);
    // Original solver semantics: a connected input may be forced open to preserve a target.
    // This report is NOT a self-sufficient chain even though the target drawer is satisfied.
    assert.ok(supplied.plan!.forced.some((flow) => flow.side === 'in' && flow.resourceKey === 'item:dust' && Math.abs(flow.perSecond - 2) < 1e-8));
    assert.equal(supplied.plan!.openGates, 1);
  } finally { await engine.close(); }
});

test('unanchored islands remain explicitly unanchored instead of inventing a production goal', async () => {
  const engine = new PlannerEngine();
  try {
    const report = await calculate(engine, project({ recipes: [recipe('a', [['x', 1]], [['y', 1]])], nodes: [node('a', 'a')] }));
    assert.deepEqual(report.plan?.unanchored, ['a']);
    near(report.nodes.a.theoreticalMachinesRequired, 0);
  } finally { await engine.close(); }
});

// Same independent public Java release input used by java-poc/NativeSolveProbe.java.
function javaChain(conflict: boolean): SolveInput {
  const port = (amount: number, resource: number, name: string) => ({ amount, resource, name, chance: 1, multiplier: 1, free: false });
  return {
    mode: 'AUTO', choice: null,
    machines: [
      { id: 'a', name: 'grind', durationTicks: 40, energyPerTick: 8, throughputFactor: 1, inputs: [port(1, 0, 'ore')], outputs: [port(2, 1, 'dust')], countFixed: false, machineCount: 1, targetInputRates: {}, targetOutputRates: {} },
      { id: 'b', name: 'smelt', durationTicks: 20, energyPerTick: 4, throughputFactor: 1, inputs: [port(1, 1, 'dust')], outputs: [port(1, 2, 'ingot')], countFixed: false, machineCount: 1, targetInputRates: {}, targetOutputRates: { 0: 3 } },
    ],
    edges: [{ id: 'ab', source: 'a', sourceOutput: 0, target: 'b', targetInput: 0 }],
    pools: conflict ? [{ machines: ['b'], capacity: 1, exact: false }] : [], drawers: [], extentPins: {}, spares: {},
  };
}
test('native LP answer agrees with the independent Java release chain and rejects its hard-cap conflict', async () => {
  const engine = new PlannerEngine();
  try {
    const answer = await engine.solve(javaChain(false)) as Answer;
    assert.equal(answer.kind, 'solved');
    if (answer.kind !== 'solved') throw new Error('Expected solved answer');
    near(answer.solution.machineCounts.a, 3);
    near(answer.solution.machineCounts.b, 3);
    near(answer.solution.edgeFlowsPerSecond.ab, 3);
    near(answer.solution.terminalInputs[0].ratePerSecond, 1.5);
    near(answer.solution.terminalOutputs[0].ratePerSecond, 3);
    assert.deepEqual(answer.solution.gatedSources, []);
    const conflict = await engine.solve(javaChain(true)) as Answer;
    assert.equal(conflict.kind, 'failed');
    if (conflict.kind !== 'failed') throw new Error('Expected failed answer');
    assert.match(JSON.stringify(conflict.failure), /INFEASIBLE|UNSATISFIABLE/);
  } finally { await engine.close(); }
});

test('all upstream corpus goldens survive the actual worker, HiGHS and JSON boundary', { timeout: 120_000 }, async (t) => {
  const engine = new PlannerEngine({ timeoutMs: 120_000 });
  try {
    for (const file of (await readdir(new URL('inputs/', corpus))).sort()) {
      await t.test(file, async () => {
        const { result, run } = await engine.solveDetailed(await json(new URL(`inputs/${file}`, corpus)));
        const diffs = support.differences(await json(new URL(`goldens/${file}`, corpus)), support.digest(result));
        assert.deepEqual(diffs, [], diffs.slice(0, 10).join('\n'));
        assert.equal(run.diagnostics?.backend, 'highs');
        assert.equal(run.diagnostics?.simplexCalls, 0);
        assert.deepEqual(run.diagnostics?.fallbackErrors, []);
      });
    }
    for (const copies of [4, 10]) await t.test(`platline-x${copies}`, async () => {
      const input = support.tile(support.parseSolveInput(await json(new URL('inputs/platline.json', corpus))), copies);
      const expected = await json(new URL(`goldens/platline-x${copies}.json`, corpus)) as { solution: Record<string, unknown> };
      const got = support.digest(await engine.solve(input));
      if (!('unneeded' in expected.solution)) delete got.solution.unneeded;
      const diffs = support.differences(expected, got);
      assert.deepEqual(diffs, [], diffs.slice(0, 10).join('\n'));
    });
  } finally { await engine.close(); }
});

test('schema validation preserves native profile fields that the upstream schema omits', async () => {
  const engine = new PlannerEngine();
  try {
    const r = recipe('r', [['a', 1]], [['b', 1]], {
      machineType: 'Declared Custom Machine', durationTicks: 1,
      machineProfile: { machineType: 'Declared Custom Machine', minimumTier: 'LV', kind: 'multiblock', perfectOverclock: true },
      machineHandlers: [{ id: 'h', label: 'Declared Custom Machine', machineType: 'Declared Custom Machine', minimumTier: 'LV' }],
    });
    const report = await calculate(engine, project({
      planMode: false, solveMode: false, recipes: [r], nodes: [node('m', 'r', { overclockTier: 'HV', machineHandlerId: 'h' })],
    }));
    // Two perfect overclocks on a one-tick multiblock recipe: 1/16 tick,
    // 320 crafts/s. Dropping machineProfile.kind wrongly floors it to 1 tick.
    near(report.nodes.m.operationRatePerSecond, 320);
  } finally { await engine.close(); }
});

test('normal and perfect overclocks agree with the independent Java release at LV, MV and HV', async () => {
  const engine = new PlannerEngine();
  try {
    // NativeMathProbe.java called the release NodeMath.compute, with no runtime ladder.
    const cases = [
      { tier: 'LV', perfect: false, duration: 40, eut: 8, output: 1 },
      { tier: 'MV', perfect: false, duration: 20, eut: 32, output: 2 },
      { tier: 'HV', perfect: false, duration: 10, eut: 128, output: 4 },
      { tier: 'LV', perfect: true, duration: 40, eut: 8, output: 1 },
      { tier: 'MV', perfect: true, duration: 10, eut: 32, output: 4 },
      { tier: 'HV', perfect: true, duration: 2, eut: 128, output: 20 },
    ] as const;
    for (const expected of cases) {
      const r = recipe('grind', [['ore', 1]], [['dust', 2]], {
        machineType: 'Macerator', durationTicks: 40, machineProfile: { machineType: 'Macerator', minimumTier: 'LV', kind: 'single', perfectOverclock: expected.perfect },
      });
      const machine = node('grind', 'grind', { overclockTier: expected.tier });
      near(getOverclockedRecipeStats(r, machine).durationTicks, expected.duration);
      const report = await calculate(engine, project({
        recipes: [r], nodes: [machine],
        storages: [storage('ore', 'ore'), storage('dust', 'dust', { targetPerSecond: expected.output, targetMode: 'exact' })],
        edges: [wire('in', 'ore', 'grind', 'ore'), wire('out', 'grind', 'dust', 'dust')],
      }));
      near(report.nodes.grind.theoreticalMachinesRequired, 1);
      near(report.nodes.grind.outputs['item:dust'].amountPerSecond, expected.output);
      near(report.totalEuT, expected.eut);
    }
  } finally { await engine.close(); }
});

test('machine mathematics match the fixed mod golden samples through both pure helpers and the complete calculator', { timeout: 30_000 }, async () => {
  const fixture = await json(new URL('mod/machine-goldens-sample.json', vendor)) as {
    cases: { case: number; recipe: Recipe; node: FactoryNode; expected: Record<string, number> }[];
  };
  const engine = new PlannerEngine();
  try {
    for (const sample of fixture.cases) {
      const stats = getOverclockedRecipeStats(sample.recipe, sample.node);
      for (const key of ['durationTicks', 'eut', 'overclockSteps', 'perfectOverclockSteps', 'perfectSpeedFactor', 'perfectEuFactor'] as const) near(stats[key], sample.expected[key]);
      near(getMachineParallelMultiplier(applyMachineHandlerToRecipe(sample.recipe, sample.node), sample.node), sample.expected.parallels);
      const report = await calculate(engine, project({ planMode: false, solveMode: false, recipes: [sample.recipe], nodes: [node('m', sample.recipe.id, sample.node)] }));
      const count = sample.node.machineCount * sample.node.parallel;
      near(report.nodes.m.operationRatePerSecond, count * sample.expected.parallels * 20 / sample.expected.durationTicks);
      near(report.nodes.m.euT, count * sample.expected.parallels * sample.expected.eut);
    }
  } finally { await engine.close(); }
});

test('invalid and oversized plans return explicit errors without poisoning the next valid request', async () => {
  const engine = new PlannerEngine();
  try {
    await assert.rejects(engine.calculate({}), hasCode('invalid'));
    const bad = chain(); bad.recipes[0].eut = Number.NaN;
    await assert.rejects(engine.calculate(bad), hasCode('invalid'));
    const fractional = chain(); fractional.nodes[0].parallel = 1.5;
    await assert.rejects(engine.calculate(fractional), hasCode('invalid'));
    const zeroSeed = chain(); zeroSeed.nodes[0].machineCount = 0;
    await assert.rejects(engine.calculate(zeroSeed), hasCode('invalid'));
    const zeroPin = chain(); zeroPin.nodes[0].solvePin = 0; zeroPin.nodes[0].solvePinExact = true;
    await assert.rejects(engine.calculate(zeroPin), hasCode('invalid'));
    const minimal = project(); delete minimal.storages;
    assert.ok((await calculate(engine, minimal)).plan?.failure);
    const cyclic: { cycle?: unknown } = {}; cyclic.cycle = cyclic;
    await assert.rejects(engine.calculate(cyclic), hasCode('invalid'));
    await assert.rejects(engine.calculate(project({ notes: 'x'.repeat(8 * 1024 * 1024 + 1) })), hasCode('limit'));
    const okay = await calculate(engine, chain()); near(okay.totalEuT, 48);
  } finally { await engine.close(); }
  const small = new PlannerEngine({ maxOutputBytes: 1024 });
  try { await assert.rejects(small.calculate(chain()), hasCode('limit')); }
  finally { await small.close(); }
});

test('shared preflight rejects excessive graph size before workspace adaptation or worker startup', async () => {
  const engine = new PlannerEngine();
  try {
    const nodes = project({ recipes: [recipe('r', [], [['x', 1]])], nodes: Array.from({ length: 1025 }, (_, i) => node(`n${i}`, 'r')) });
    assert.throws(() => checkPlannerInput(nodes), (error) => hasCode('limit')(error) && /nodes/.test((error as Error).message));
    await assert.rejects(engine.calculate(nodes), hasCode('limit'));
    const edges = chain(); edges.edges = Array.from({ length: 4097 }, (_, i) => wire(`e${i}`, 'crush', 'press', 'dust'));
    await assert.rejects(engine.calculate(edges), hasCode('limit'));
    const constrained = javaChain(false); constrained.pools = Array.from({ length: 4097 }, () => ({ machines: ['a'], capacity: 1, exact: false }));
    await assert.rejects(engine.solve(constrained), hasCode('limit'));
    assert.equal(engine.info().workerStarts, 0);
    assert.equal(engine.info().structuralLimits.nodes, 1024);
    near((await calculate(engine, chain())).totalEuT, 48);
  } finally { await engine.close(); }
});

test('an oversized native LP stage is rejected before allocation and the same worker remains usable', async () => {
  const engine = new PlannerEngine();
  try {
    // Below every input graph cap. Its unbalanced recycling rings require an LP
    // whose real rows x columns exceeds the fixed release matrix budget.
    const size = 550;
    const dense = project({
      recipes: [recipe('r', [['x', 1], ['y', 1]], [['x', 2], ['y', 0.5]])],
      nodes: Array.from({ length: size }, (_, i) => node(`m${i}`, 'r', i === 0 ? { portRates: { 'output:item:x': 1 } } : {})),
      edges: Array.from({ length: size * 2 }, (_, i) => wire(`e${i}`, `m${Math.floor(i / 2)}`, `m${(Math.floor(i / 2) + 1) % size}`, i % 2 ? 'y' : 'x')),
    });
    checkPlannerInput(dense);
    await assert.rejects(engine.calculate(dense), (error) => hasCode('limit')(error) && /lpDenseCells/.test((error as Error).message));
    assert.equal(engine.info().lastRun?.diagnostics?.simplexCalls, 0);
    const starts = engine.info().workerStarts;
    near((await calculate(engine, chain())).totalEuT, 48);
    assert.equal(engine.info().workerStarts, starts);
  } finally { await engine.close(); }
});

test('a timed-out real solve leaves the main event loop responsive and the next request starts a healthy worker', async () => {
  const engine = new PlannerEngine();
  const heavy = await heavyInput();
  try {
    await engine.calculate(chain());
    const starts = engine.info().workerStarts;
    let mainThreadTicked = false;
    const timer = setTimeout(() => { mainThreadTicked = true; }, 10);
    await assert.rejects(engine.solve(heavy, { timeoutMs: 80 }), hasCode('timeout'));
    clearTimeout(timer);
    assert.ok(mainThreadTicked, 'main event loop was blocked by solver CPU');
    assert.deepEqual(JSON.parse(JSON.stringify(engine.info().lastRun)), engine.info().lastRun);
    near((await calculate(engine, chain())).totalEuT, 48);
    assert.ok(engine.info().workerStarts > starts);
  } finally { await engine.close(); }
});

test('bounded concurrent requests report busy, queued cancellation preserves the running worker, and active cancellation recovers', async () => {
  const engine = new PlannerEngine({ maxQueued: 1 });
  const heavy = await heavyInput();
  try {
    await engine.calculate(chain());
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = assert.rejects(engine.solve(heavy, { signal: activeController.signal }), hasCode('aborted'));
    const queued = assert.rejects(engine.calculate(chain(), { signal: queuedController.signal }), hasCode('aborted'));
    await assert.rejects(engine.calculate(chain()), hasCode('busy'));
    queuedController.abort();
    await queued;
    assert.equal(engine.info().state, 'running');
    setTimeout(() => activeController.abort(), 40);
    await active;
    near((await calculate(engine, chain())).totalEuT, 48);
    const preAborted = new AbortController(); preAborted.abort();
    await assert.rejects(engine.calculate(chain(), { signal: preAborted.signal }), hasCode('aborted'));
  } finally { await engine.close(); }
  await assert.rejects(engine.calculate(chain()), hasCode('closed'));
});

test('queue deadlines and close reject their own requests and do not leave a worker alive', async () => {
  const engine = new PlannerEngine();
  const heavy = await heavyInput();
  await engine.calculate(chain());
  const active = assert.rejects(engine.solve(heavy), hasCode('closed'));
  const queued = assert.rejects(engine.calculate(chain(), { timeoutMs: 20 }), hasCode('timeout'));
  await queued;
  assert.equal(engine.info().state, 'running');
  const waiting = assert.rejects(engine.calculate(chain()), hasCode('closed'));
  await engine.close();
  await Promise.all([active, waiting]);
  await engine.close();
  assert.equal(engine.info().state, 'closed');
  assert.equal(engine.info().workerReady, false);
});

test('relocated release runs with no node_modules and recovers visibly from missing bundled WASM', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'planner-release-'));
  const release = join(temp, 'release');
  try {
    await mkdir(join(release, 'src/planner'), { recursive: true });
    await mkdir(join(release, 'vendor/gtnh-planner/dist'), { recursive: true });
    for (const name of ['engine.ts', 'engine-worker.ts']) await cp(new URL(`../src/planner/${name}`, import.meta.url), join(release, 'src/planner', name));
    for (const name of ['runtime.cjs', 'highs.wasm']) await cp(new URL(`dist/${name}`, vendor), join(release, 'vendor/gtnh-planner/dist', name));
    for (const name of ['limits.mjs', 'shape-budget.mjs']) await cp(new URL(name, vendor), join(release, 'vendor/gtnh-planner', name));
    await writeFile(join(release, 'package.json'), '{"type":"module"}');
    const moduleUrl = pathToFileURL(join(release, 'src/planner/engine.ts')).href;
    const wasm = join(release, 'vendor/gtnh-planner/dist/highs.wasm');
    const source = `
      import assert from 'node:assert/strict';
      import { rename } from 'node:fs/promises';
      import { PlannerEngine } from ${JSON.stringify(moduleUrl)};
      const wasm = ${JSON.stringify(wasm)};
      const input = ${JSON.stringify(chain())};
      const engine = new PlannerEngine();
      try {
        await rename(wasm, wasm + '.unavailable');
        await assert.rejects(engine.calculate(input), error => error.code === 'unavailable');
        assert.equal(engine.info().workerReady, false);
        await rename(wasm + '.unavailable', wasm);
        const {result,run} = await engine.calculateDetailed(input);
        assert.equal(result.totalEuT, 48);
        assert.equal(run.diagnostics.backend, 'highs');
        assert.equal(run.diagnostics.simplexCalls, 0);
      } finally { await engine.close(); }
    `;
    await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', source], { cwd: temp, timeout: 30_000 });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('committed sources and shipped binaries match the reproducible source and output manifests', async () => {
  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const sources = await json(new URL('source-files.json', vendor)) as Record<string, string>;
  for (const [file, expected] of Object.entries(sources)) assert.equal(sha256(await readFile(new URL(`upstream/${file}`, vendor))), expected, file);
  const mod = await json(new URL('mod-files.json', vendor)) as Record<string, string>;
  for (const [file, expected] of Object.entries(mod)) assert.equal(sha256(await readFile(new URL(file, vendor))), expected, file);
  const manifest = await json(new URL('provenance.json', vendor)) as { build: { inputHashes: Record<string, string>; outputHashes: Record<string, string> }; runtime: string[] };
  for (const [file, expected] of Object.entries(manifest.build.inputHashes)) assert.equal(sha256(await readFile(new URL(file, vendor))), expected, file);
  for (const [file, expected] of Object.entries(manifest.build.outputHashes)) assert.equal(sha256(await readFile(new URL(file, vendor))), expected, file);
  // Published paths are relative to the vendor directory, never a development cwd.
  for (const path of manifest.runtime) assert.ok((await readFile(new URL(path, vendor))).length > 0, fileURLToPath(new URL(path, vendor)));
});
