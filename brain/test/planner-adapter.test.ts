import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RecipeBook } from '../src/packdata/recipes.ts'
import type { PackData } from '../src/packdata/index.ts'
import { describeRecipes, prepareProject, portHandle } from '../src/planner/adapter.ts'
import { summarizeReport } from '../src/planner/report.ts'
import { PlannerEngine } from '../src/planner/engine.ts'
import { NATIVE_PROJECT_EXAMPLE } from '../src/planner/model.ts'
import type { DescribedRecipe, FactoryProject, Recipe, ThroughputResult } from '../src/planner/model.ts'

const handlers = [{ key: 'gt.recipe.macerator', name: '研磨机', machines: [{ id: 'gregtech:gt.blockmachines', meta: 301 }], read: 'gregtech' }]
function fixture(rows: object[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-adapter-'))
  fs.writeFileSync(path.join(dir, 'handlers.json'), JSON.stringify(handlers))
  fs.writeFileSync(path.join(dir, 'recipes.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  const recipes = RecipeBook.load(dir)!.book
  const packdata: PackData = { dir, recipes }
  return { packdata, close() { recipes.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}
const row = { h: 'gt.recipe.macerator', in: [{ id: 'minecraft:stone', meta: 1, n: 2 }], out: [{ id: 'minecraft:sand', meta: 1, n: 3, chance: .25 }], eut: 2, ticks: 100 }
function projectFrom(d: DescribedRecipe, target = 1): FactoryProject {
  const output = d.recipe.outputs[0]
  return { schemaVersion: 1, id: 'test', name: 'Native local plan', solveMode: true, planMode: true, recipes: [d.recipe], nodes: [d.nodeTemplate],
    storages: [{ id: 'product', kind: output.kind, resourceId: output.id, targetMode: 'at-least', targetPerSecond: target, position: { x: 100, y: 0 } }],
    edges: [{ id: 'product-wire', source: d.nodeTemplate.id, target: 'product', resourceKind: output.kind, resourceId: output.id, sourceHandle: portHandle('output', output.kind, output.id) }], fuelProfiles: [] }
}
function noErrors(result: { issues: { severity: string; message: string }[] }): void { assert.deepEqual(result.issues.filter(i => i.severity === 'error'), []) }

test('describe keeps damage, candidates, grids, count-zero tools, chance, fluids and special/fake data in a full binding', () => {
  const f = fixture([{ ...row, in: [
    ...row.in, { ore: 'dustIron', n: 2, g: 4, any: [['test:iron', 2], ['test:iron', 3]], more: 7 },
    { any: [['test:dust', 1], ['test:dust', 2]], more: 0, n: 1 },
    { id: 'gregtech:gt.integrated_circuit', meta: 12, n: 0 },
  ], fin: [{ f: 'water', name: '水', mb: 1000 }], fout: [{ f: 'steam', name: '蒸汽', mb: 1600 }], special: 17, fake: true }])
  try {
    const d = describeRecipes(f.packdata, [0]).recipes[0]
    assert.equal(d.recipe.inputs[0].id, 'minecraft:stone@1')
    assert.equal(d.recipe.inputs[1].id, 'oredict:dustIron')
    assert.deepEqual(d.recipe.inputs[1].alternatives?.map(a => a.id), ['test:iron@2', 'test:iron@3'])
    assert.equal(d.recipe.inputs[3].consumed, false)
    assert.equal(d.recipe.inputs[3].amount, 1)
    assert.equal(d.recipe.programmedCircuit, '12')
    assert.equal(d.prerequisites.length, 1)
    assert.equal((d.prerequisites[0].localSlot as { n: number }).n, 0)
    assert.equal(d.recipe.outputs[0].chance, .25)
    assert.equal(d.recipe.inputs[4].amount, 1000)
    assert.equal(d.ports[4].unit, 'mB/craft')
    assert.equal(d.recipe.specialValue, 17)
    assert.deepEqual(d.recipe.nei?.additionalInfo, ['Special value: 17'])
    assert.equal(d.provenance.binding?.snapshot.fake, true)
    assert.equal(d.provenance.binding?.snapshot.raw.fake, true)
    assert.deepEqual(d.provenance.binding?.snapshot.raw.fin, [{ f: 'water', name: '水', mb: 1000 }])
    assert.equal(d.provenance.binding?.snapshot.in[1].g, 4)
    assert.match(d.ports[0].handle, /minecraft%3Astone%401$/)
    assert.equal(d.nodeTemplate.machineHandlerId, 'macerator')
    noErrors(prepareProject(f.packdata, projectFrom(d)))
  } finally { f.close() }
})

test('same local recipe moved to another ref keeps identity, while stale bindings require refresh or explicit old assumptions', () => {
  const f = fixture([row, { ...row, ticks: 200 }])
  try {
    const d = describeRecipes(f.packdata, [0]).recipes[0]
    const plan = projectFrom(d)
    fs.writeFileSync(path.join(f.packdata.dir, 'recipes.jsonl'), JSON.stringify({ ...row, ticks: 200 }) + '\n' + JSON.stringify(row) + '\n')
    f.packdata.recipes!.close()
    f.packdata.recipes = RecipeBook.load(f.packdata.dir)!.book
    const moved = describeRecipes(f.packdata, [1]).recipes[0]
    assert.equal(moved.recipe.id, d.recipe.id)
    assert(prepareProject(f.packdata, plan).issues.some(i => i.code === 'STALE_LOCAL_RECIPE' && i.severity === 'error'))
    noErrors(prepareProject(f.packdata, plan, { allowStale: true }))
    assert.equal(prepareProject(f.packdata, plan, { allowStale: true }).provenance[0].status, 'local-stale')
    f.packdata.recipes.close()
  } finally { f.close() }
})

test('bound native formula edits are rejected, while explicitly declared native recipes remain usable assumptions', () => {
  const f = fixture([row])
  try {
    const plan = projectFrom(describeRecipes(f.packdata, [0]).recipes[0])
    plan.recipes[0].durationTicks = 1
    assert(prepareProject(f.packdata, plan).issues.some(i => i.code === 'BINDING_CHANGED'))
    delete plan.recipes[0].metadata!.localBinding
    const prepared = prepareProject(f.packdata, plan)
    noErrors(prepared)
    assert.equal(prepared.provenance[0].status, 'declared-unverified')
  } finally { f.close() }
})

test('ore selection uses native decimal input overrides and refuses an ambiguous resource row rather than silently choosing the first', () => {
  const f = fixture([{ ...row, in: [{ ore: 'a', n: 1, any: [['minecraft:stone', 0]], more: 0 }, { ore: 'b', n: 1, any: [['minecraft:stone', 0]], more: 0 }] }])
  try {
    const p = projectFrom(describeRecipes(f.packdata, [0]).recipes[0])
    p.storages!.push({ id: 'source', kind: 'item', resourceId: 'minecraft:stone', position: { x: -100, y: 0 } })
    p.edges.push({ id: 'feed', source: 'source', target: p.nodes[0].id, resourceKind: 'item', resourceId: 'minecraft:stone' })
    assert(prepareProject(f.packdata, p).issues.some(i => i.code === 'AMBIGUOUS_RESOURCE_PORT'))
    p.nodes[0].recipeInputOverrides = { '1': { kind: 'item', id: 'minecraft:stone', amount: 1 } }
    p.edges[1].targetHandle = portHandle('input', 'item', 'minecraft:stone')
    noErrors(prepareProject(f.packdata, p))
    p.edges[1].resourceId = 'minecraft:stone@2'
    assert(prepareProject(f.packdata, p).issues.some(i => i.code === 'EDGE_RESOURCE_MISMATCH'))
  } finally { f.close() }
})

test('native count pins and rate pins cannot silently erase a hard capacity', async () => {
  const engine = new PlannerEngine()
  try {
    const p = structuredClone(NATIVE_PROJECT_EXAMPLE)
    p.recipes[0].minimumTier = p.nodes[0].overclockTier = 'LV'
    p.recipes[0].eut = 30
    p.recipes[0].durationTicks = 20
    p.nodes[0].solvePin = 1
    p.storages![0].targetPerSecond = -10
    p.storages![1].targetPerSecond = 3
    noErrors(prepareProject(undefined, p))
    const report = await engine.calculate(p) as ThroughputResult
    const summary = summarizeReport(p, report)
    assert.equal(summary.status, 'unmet')
    assert(report.plan?.shortfalls?.some(s => s.drawerId === 'product' && s.target === 3 && s.reachable <= 1 + 1e-7))
    assert(summary.machines[0].fractionalMachines <= 1 + 1e-7)
    assert.equal(summary.machines[0].capacityExceeded, false)
    assert.strictEqual(summary.nativeReport, report)
    p.nodes[0].solvePinExact = true
    p.nodes[0].portRates = { [portHandle('output', 'item', 'example:product@0')]: 3 }
    assert(prepareProject(undefined, p).issues.some(i => i.code === 'COUNT_PIN_TARGET_CONFLICT'))
  } finally { await engine.close() }
})

test('source at-most limit and product shortfalls remain visible even when the native plan has a solution', async () => {
  const engine = new PlannerEngine()
  try {
    const p = structuredClone(NATIVE_PROJECT_EXAMPLE)
    p.recipes[0].minimumTier = p.nodes[0].overclockTier = 'LV'; p.recipes[0].eut = 30
    delete p.nodes[0].solvePin
    p.storages![0].targetPerSecond = -.5
    p.storages![1].targetPerSecond = 2
    const report = await engine.calculate(p) as ThroughputResult
    const summary = summarizeReport(p, report)
    assert.notEqual(summary.status, 'satisfied')
    assert(summary.goals.some(g => g.ownerId === 'product' && !g.met))
    assert(summary.goals.some(g => g.ownerId === 'source' && g.met))
    assert(summary.shortfalls.length > 0)
  } finally { await engine.close() }
})

test('an unlimited native source still means sustained external supply, not inventory already available', async () => {
  const engine = new PlannerEngine()
  try {
    const p = structuredClone(NATIVE_PROJECT_EXAMPLE)
    delete p.storages![0].targetPerSecond
    delete p.nodes[0].solvePin
    const summary = summarizeReport(p, await engine.calculate(p))
    assert.equal(summary.status, 'needs-external-supply')
    assert(summary.externalInputs.some(row => (row as { source: string }).source === 'source-storage'))
    assert(summary.goals.every(g => g.met))
  } finally { await engine.close() }
})

test('source caps can produce forced imports without native shortfalls, and the report still requires extra supply', async () => {
  const engine = new PlannerEngine()
  try {
    const p: FactoryProject = { schemaVersion: 1, id: 'forced', name: 'Capped ore with forced dust', planMode: true, solveMode: true,
      recipes: [
        { id: 'crush', name: 'Crush', machineType: 'Macerator', minimumTier: 'LV', eut: 30, durationTicks: 20, inputs: [{ kind: 'item', id: 'ore', amount: 1 }], outputs: [{ kind: 'item', id: 'dust', amount: 2 }] },
        { id: 'press', name: 'Press', machineType: 'Bending Machine', minimumTier: 'LV', eut: 30, durationTicks: 20, inputs: [{ kind: 'item', id: 'dust', amount: 1 }], outputs: [{ kind: 'item', id: 'plate', amount: 1 }] },
      ], nodes: ['crush', 'press'].map(id => ({ id, recipeId: id, machineCount: 1, parallel: 1, overclockTier: 'LV', enabled: true, position: { x: 0, y: 0 } })),
      storages: [
        { id: 'ore-source', kind: 'item', resourceId: 'ore', targetMode: 'at-most', targetPerSecond: -.5, position: { x: 0, y: 0 } },
        { id: 'product', kind: 'item', resourceId: 'plate', targetMode: 'exact', targetPerSecond: 3, position: { x: 0, y: 0 } },
      ], edges: [
        { id: 'supply', source: 'ore-source', target: 'crush', resourceKind: 'item', resourceId: 'ore' },
        { id: 'dust', source: 'crush', target: 'press', resourceKind: 'item', resourceId: 'dust' },
        { id: 'out', source: 'press', target: 'product', resourceKind: 'item', resourceId: 'plate' },
      ], fuelProfiles: [] }
    noErrors(prepareProject(undefined, p))
    const nativeReport = await engine.calculate(p) as ThroughputResult
    const summary = summarizeReport(p, nativeReport)
    assert.deepEqual(nativeReport.plan?.unmetDrawers, [])
    assert(summary.goals.every(g => g.met))
    assert(nativeReport.plan?.forced.some(f => f.side === 'in' && f.resourceKey === 'item:dust' && Math.abs(f.perSecond - 2) < 1e-6))
    assert.equal(summary.status, 'needs-external-supply')
    assert(summary.issues.some(i => i.code === 'FORCED_IMPORT' && i.nodeId === 'press'))
    assert(summary.externalInputs.some(row => (row as { source: string; resourceKey: string }).source === 'forced' && (row as { resourceKey: string }).resourceKey === 'item:dust'))
  } finally { await engine.close() }
})

test('shared native extraRecipes round machine time once for the card, not once for every recipe', async () => {
  const engine = new PlannerEngine()
  try {
    const recipe = (id: string, output: string): Recipe => ({ id, name: id, kind: 'custom', machineType: 'Macerator', minimumTier: 'LV', durationTicks: 20, eut: 30, inputs: [{ kind: 'item', id: 'feed', amount: 1 }], outputs: [{ kind: 'item', id: output, amount: 1 }] })
    const p: FactoryProject = { schemaVersion: 1, id: 'shared', name: 'Shared machine', solveMode: true, planMode: true, recipes: [recipe('a', 'a'), recipe('b', 'b')],
      nodes: [{ id: 'shared', recipeId: 'a', extraRecipes: [{ recipeId: 'b' }], enabled: true, machineCount: 1, parallel: 1, overclockTier: 'LV', position: { x: 0, y: 0 } }],
      storages: ['a', 'b'].map(id => ({ id, kind: 'item' as const, resourceId: id, targetMode: 'exact' as const, targetPerSecond: .3, position: { x: 100, y: 0 } })),
      edges: ['a', 'b'].map((id, i) => ({ id, source: 'shared', target: id, resourceKind: 'item', resourceId: id, sourceHandle: `${i ? 'r1:' : ''}output:item:${id}` })), fuelProfiles: [] }
    noErrors(prepareProject(undefined, p))
    const report = await engine.calculate(p) as ThroughputResult
    const summary = summarizeReport(p, report)
    assert.equal(summary.machines.length, 1)
    assert.equal(summary.machines[0].shared, true)
    assert(Math.abs(summary.machines[0].fractionalMachines - .6) < 1e-7)
    assert.equal(summary.machines[0].buildMachines, 1)
    assert(summary.goals.every(g => g.met))
    p.recipes[1].machineType = 'Chemical Reactor'
    assert(prepareProject(undefined, p).issues.some(i => i.code === 'SHARED_MACHINE_MISMATCH'))
  } finally { await engine.close() }
})

test('non-finite input, wrong resource edges and missing machine metadata stop before calculation', () => {
  const f = fixture([row, { ...row, h: 'unknown.machine.map' }])
  try {
    const p = projectFrom(describeRecipes(f.packdata, [0]).recipes[0])
    p.nodes[0].parallel = Infinity
    assert(prepareProject(f.packdata, p).issues.some(i => i.code === 'NON_FINITE_NUMBER'))
    p.nodes[0].parallel = 1; p.edges[0].resourceKind = 'fluid'
    assert(prepareProject(f.packdata, p).issues.some(i => i.code === 'EDGE_RESOURCE_MISMATCH'))
    assert(describeRecipes(f.packdata, [1]).issues.some(i => i.code === 'MISSING_MACHINE_MAP'))
  } finally { f.close() }
})

const realDir = path.resolve(import.meta.dirname, '../packdata')
test('real local packdata describes and solves tool, fluid, probability and heat recipes through the original engine', { skip: !fs.existsSync(path.join(realDir, 'recipes.jsonl')) }, async () => {
  const recipes = RecipeBook.load(realDir)!.book
  const packdata: PackData = { dir: realDir, recipes }
  const engine = new PlannerEngine()
  try {
    // Find by full local identity, not export-dependent line refs.
    const find = (handler: string, input: string, output: string) => {
      for (const ref of recipes.makesOf(output, 0)) {
        const r = recipes.get(ref)!
        if (r.handler.key === handler && r.in.some(s => s.kind === 'item' && s.id === input)) return ref
      }
      return undefined
    }
    const brickRef = find('gt.recipe.alloysmelter', 'minecraft:clay_ball', 'minecraft:brick')
    const concreteRef = find('gt.recipe.mixer', 'etfuturum:concrete_powder', 'etfuturum:concrete')
    assert.notEqual(brickRef, undefined); assert.notEqual(concreteRef, undefined)
    const brick = describeRecipes(packdata, [brickRef!]).recipes[0]
    const p = projectFrom(brick, .05)
    noErrors(prepareProject(packdata, p))
    const report = await engine.calculate(p) as ThroughputResult
    const summary = summarizeReport(p, report, prepareProject(packdata, p))
    assert(summary.goals.every(g => g.met))
    assert.equal(summary.status, 'needs-external-supply')
    assert.equal(summary.machines[0].buildMachines, 1)
    assert.equal(report.nodes[brick.nodeTemplate.id].inputs['item:gregtech:gt.metaitem.01@32306'], undefined)
    const extractorRef = find('gt.recipe.extractor', 'minecraft:clay', 'minecraft:clay_ball')
    assert.notEqual(extractorRef, undefined)
    const extractor = describeRecipes(packdata, [extractorRef!]).recipes[0]
    const chain = projectFrom(brick, .2)
    chain.recipes.push(extractor.recipe); chain.nodes.push(extractor.nodeTemplate)
    chain.storages!.push({ id: 'clay-source', kind: 'item', resourceId: 'minecraft:clay', targetMode: 'at-most', targetPerSecond: -.05, position: { x: -200, y: 0 } })
    chain.edges.push(
      { id: 'clay-source-wire', source: 'clay-source', target: extractor.nodeTemplate.id, resourceKind: 'item', resourceId: 'minecraft:clay' },
      { id: 'clay-ball-wire', source: extractor.nodeTemplate.id, target: brick.nodeTemplate.id, resourceKind: 'item', resourceId: 'minecraft:clay_ball' },
    )
    noErrors(prepareProject(packdata, chain))
    const chainReport = await engine.calculate(chain) as ThroughputResult
    assert(Math.abs(chainReport.edges['clay-ball-wire'].transferredPerSecond - .2) < 1e-7)
    assert(Math.abs(chainReport.storages['clay-source'].consumedPerSecond - .05) < 1e-7)
    assert(summarizeReport(chain, chainReport).goals.every(g => g.met))
    p.nodes[0].solvePin = 1; p.storages![0].targetPerSecond = .3
    const capped = summarizeReport(p, await engine.calculate(p))
    assert.equal(capped.status, 'unmet')
    assert(capped.shortfalls.length > 0)
    const concrete = describeRecipes(packdata, [concreteRef!]).recipes[0]
    const c = projectFrom(concrete, 8)
    noErrors(prepareProject(packdata, c))
    const cr = await engine.calculate(c) as ThroughputResult
    assert(Math.abs(cr.nodes[concrete.nodeTemplate.id].inputs['fluid:water'].amountPerSecond - 1000) < 1e-6)
    // A genuine chanced recipe, selected by a local registered ingredient id.
    const chanceRef = recipes.usesOf('GoodGenerator:naquadahMass', 0).find(ref => recipes.get(ref)?.handler.key === 'gt.recipe.macerator')
    assert.notEqual(chanceRef, undefined)
    const chance = describeRecipes(packdata, [chanceRef!]).recipes[0]
    const chp = projectFrom(chance, 1)
    const chr = await engine.calculate(chp) as ThroughputResult
    const byproduct = chance.recipe.outputs.find(o => o.chance === .01)!
    assert(byproduct)
    assert(Math.abs(chr.nodes[chance.nodeTemplate.id].outputs[`item:${byproduct.id}`].amountPerSecond - .01) < 1e-8)
    assert(summarizeReport(chp, chr).assumptions.some(s => /expected long-run/.test(s)))
    const heatRef = recipes.usesOf('miscutils:item.BasicAgrichemItem', 2).find(ref => recipes.get(ref)?.handler.key === 'gt.recipe.blastfurnace')
    assert.notEqual(heatRef, undefined)
    const heat = describeRecipes(packdata, [heatRef!]).recipes[0]
    assert.equal(heat.recipe.specialValue, 1200)
    assert.equal(heat.nodeTemplate.coilTier, 'cupronickel')
    const hp = projectFrom(heat, 1)
    noErrors(prepareProject(packdata, hp))
    assert(summarizeReport(hp, await engine.calculate(hp)).goals.every(g => g.met))
  } finally { recipes.close(); await engine.close() }
})
