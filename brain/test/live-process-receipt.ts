// Private, disposable testserver only: clears and rebuilds the area at (10,190,7).
// Run from brain/: node test/live-process-receipt.ts [evidence-directory]
// RCON sets up whole-stack inputs, not the processing or its results. Both model tools use the real bridge.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BridgeClient } from '../src/bridge/client.ts'
import { BridgeApi } from '../src/bridge/api.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/index.ts'
import { BRAIN_ROOT, TESTSERVER_BRIDGE_PORT, TOKEN_FILE, assertPrivateTestserver, openRcon, sleep, until } from './live-brain.ts'

assertPrivateTestserver()
const dir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'process-receipts-'))
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
console.log('Evidence:', dir)
const client = new BridgeClient({ address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }), token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(), clientName: 'receipt-acceptance' })
const bridge = new BridgeApi(client), bot = 'ReceiptTest', machine = { x: 10, y: 190, z: 7 }, chest = { ...machine, x: 9 }
const rcon = await openRcon(), send = rcon.send
const packdata = loadPackData(path.join(BRAIN_ROOT, 'packdata'))
let started = ''
const ctx: ToolContext = { bridge, botName: bot, packdata, memory: new MemoryStore(dir, () => 100), manuals: new ManualStore(path.join(BRAIN_ROOT, 'manuals'), dir), reminders: { add: () => ({ id: 'unused', dueAt: 0 }) }, now: Date.now, hooks: { taskStarted: t => { started = t.id } } }
const tool = (name: string, input: object) => runTool(ALL_TOOLS, ctx, name, input, { maxResultChars: 32000 })
const set = (x: number, block: string) => send(`setblock ${x} 190 7 ${block}`)
const setup = async (nbt: string, gifts: string[], west = 'minecraft:air') => {
  await bridge.screenClose(bot); await send(`clear ${bot}`)
  await set(10, 'minecraft:air'); await set(9, 'minecraft:air'); await set(9, west)
  assert.match(await set(10, `gregtech:gt.blockmachines 0 replace {mFacing:4s,mMainFacing:3,mStoredEnergy:32768L,${nbt}}`), /block placed/i)
  for (const g of gifts) assert.match(await send(`give ${bot} ${g}`), /given|gave/i)
  await sleep(500)
}
const tank = async (pos = machine) => (await bridge.worldBlock(pos)).tanks ?? []
const processItems = async (name: string, args: object, during?: () => Promise<void>) => {
  const before = await tank()
  started = ''
  const start = await tool('process_items', { machine, ...args })
  assert.ok(started, start.content)
  await during?.()
  const task = await until(name, async () => (await bridge.taskList(bot)).recent?.find(t => t.id === started), 90000)
  const status = await tool('task_status', {})
  const text = status.content.split('\n').find(l => l.startsWith(`- ${task.id} `)) ?? ''
  const actual = { before, after: await tank(), west: (await bridge.worldContainers(chest, { radius: 0 })).containers?.[0], bag: (await bridge.botStatus(bot)).inventory }
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ start: start.content, task, actual, text }, null, 2))
  console.log(name, text)
  return { task, text, actual }
}
const failures: Error[] = []
async function check(fn: () => Promise<void>) { try { await fn() } catch (e) { console.error(e); failures.push(e as Error) } }
let spawned = false, switchSpawned = false
const operator = 'ReceiptSwitch'
client.start()
try {
  await until('bridge', () => client.isConnected(), 10000)
  assert.ok(!(await bridge.botList()).bots?.some(b => b.name === bot && b.online), `${bot} already in use`)
  await bridge.botSpawn({ name: bot, dim: 0, x: 10, y: 190, z: 10 }); spawned = true
  await bridge.taskCancel(bot); await send(`tp ${bot} 10 190 10`); await sleep(500)
  for (let x=8; x<=12; x++) for (let z=6; z<=11; z++) await send(`setblock ${x} 189 ${z} minecraft:stone`)
  await send(`tp ${bot} 10 190 10`)
  await check(async () => {
    await setup('mID:213s,mItemTransfer:1b,mFluid:{FluidName:"molten.plastic",Amount:16092}', ['gregtech:gt.blockmachines 4 1246', 'gregtech:gt.blockcasings 2 1'], 'minecraft:chest')
    const { task, text, actual } = await processItems('casings', { recipe: 108461, rounds: 2 })
    assert.equal(task.state, 'done'); assert.equal(actual.before.find(f => f.fluid === 'molten.plastic')?.amount, 16092)
    assert.equal(actual.after.find(f => f.fluid === 'molten.plastic')?.amount, 15516)
    assert.equal(task.result?.madeFluids, undefined)
    assert.ok(actual.west?.items?.some(i => i.id === 'gregtech:gt.blockmachines' && i.meta === 11 && i.count === 2)); assert.match(text, /2× gregtech:gt.blockmachines\/11.*west face/)
    assert.doesNotMatch(text, /what it made is a fluid|fluid product.*plastic/i); assert.match(text, /-576 mB/)
  })
  await check(async () => {
    await setup('mID:512s,mFluidOut:{FluidName:"molten.steel",Amount:1000}', ['gregtech:gt.metaitem.01 2 11305'])
    const { task, text, actual } = await processItems('steel', { recipe: 207525, rounds: 2 })
    assert.equal(task.state, 'done'); assert.equal(actual.before.find(f => f.fluid === 'molten.steel')?.amount, 1000)
    assert.equal(actual.after.find(f => f.fluid === 'molten.steel')?.amount, 1288)
    assert.deepEqual(task.result?.madeFluids, [{ fluid: 'molten.steel', amount: 288 }])
    assert.match(text, /fluid product[^;]*\b288 mB/i); assert.match(text, /\+288 mB/)
  })
  await check(async () => {
    // Native auto-output into the adjacent solidifier. The task can see the switch, not the fluid's destination.
    await setup('mID:512s,mFluidTransfer:1b', ['gregtech:gt.metaitem.01 2 11305'], 'gregtech:gt.blockmachines 0 replace {mID:522s,mFacing:4s,mMainFacing:3}')
    const { task, text, actual } = await processItems('drained', { recipe: 207525, rounds: 2 })
    assert.equal(task.state, 'done'); assert.ok(!actual.after.some(f => f.fluid === 'molten.steel' && f.amount))
    assert.equal((await tank(chest)).find(f => f.fluid === 'molten.steel')?.amount, 288)
    assert.match(text, /fluid product[^;]*\b288 mB/i); assert.match(text, /destination unobserved/); assert.doesNotMatch(text, /stays in|went further|was moved .*into|what it makes leaves/i)
  })
  await check(async () => {
    // A configured flask and its blank have the same registry id/meta. Stop mid-batch with both in the bag.
    await setup('mID:211s', ['gregtech:gt.Volumetric_Flask 32'])
    const { task, text, actual } = await processItems('same-kind', { recipe: 109588, rounds: 32, wait: 5 })
    const flasks = (key: string): number => (task.result?.[key] as {id: string; count: number}[] | undefined)?.find(i => i.id === 'gregtech:gt.Volumetric_Flask')?.count ?? 0
    assert.equal(task.state, 'done'); assert.ok(flasks('collected') > 0 && flasks('returnedInputs') > 0, text)
    assert.equal(flasks('outputs'), flasks('collected') + flasks('returnedInputs'))
    const inBag = (capacity: number) => actual.bag?.filter(i => i.id === 'gregtech:gt.Volumetric_Flask' && i.fluidContainer?.capacity === capacity).reduce((n, i) => n + i.count, 0)
    assert.equal(flasks('collected'), inBag(144)); assert.equal(flasks('returnedInputs'), inBag(1000))
    assert.ok(text.includes(`collected from output: ${flasks('collected')}× gregtech:gt.Volumetric_Flask`))
    assert.ok(text.includes(`inputs actually returned: ${flasks('returnedInputs')}× gregtech:gt.Volumetric_Flask`))
  })
  await check(async () => {
    await setup('mID:303s', ['minecraft:bedrock 2'])
    const { task, text, actual } = await processItems('return', { inputs: [{ id: 'minecraft:bedrock', count: 2 }], wait: 5 })
    assert.equal(task.state, 'failed'); assert.ok(actual.bag?.some(i => i.id === 'minecraft:bedrock' && i.count === 2))
    assert.match(text, /inputs actually returned: 2× minecraft:bedrock/); assert.equal(text.match(/2× minecraft:bedrock/g)?.length, 1)
    assert.deepEqual(task.result?.collected, []); assert.equal((task.result?.outputs as {count: number}[])[0]?.count, 2)
  })
  await check(async () => {
    await setup('mID:512s,mFluidOut:{FluidName:"molten.steel",Amount:1000}', ['gregtech:gt.metaitem.01 1 11305'])
    assert.ok(!(await bridge.botList()).bots?.some(b => b.name === operator && b.online), `${operator} already in use`)
    await bridge.botSpawn({ name: operator, dim: 0, x: 11, y: 190, z: 10 }); switchSpawned = true
    await send(`tp ${operator} 11 190 10`)
    await sleep(500)
    const { task, text, actual } = await processItems('disable-mid-round', { recipe: 207525 }, async () => {
      const state = () => bridge.worldMachines(machine, { radius: 0 }).then(m => m.machines?.[0])
      const on = await until('live progress', async () => { const m = await state(); return m && (m.progress ?? 0) > 0 && m }, 10000, 50)
      const ui = await bridge.screenOpen(operator, machine)
      assert.ok(ui.controls?.some(c => c.key === 'powerSwitch:0' && c.value === true), JSON.stringify(ui))
      await bridge.screenSet(operator, { key: 'powerSwitch:0', value: false })
      const off = await state(); fs.writeFileSync(path.join(dir, 'native-switch.json'), JSON.stringify({ on, off }, null, 2))
      assert.ok(off?.switchedOff && (off.maxProgress ?? 0) > 0, 'switch must be off before completion')
      await bridge.screenClose(operator)
    })
    assert.equal(actual.after.find(f => f.fluid === 'molten.steel')?.amount, 1144)
    assert.equal(task.state, 'done', text); assert.match(text, /fluid products[^;]*144 mB/)
  })
  await check(async () => {
    for (let x=9; x<=11; x++) for (let y=189; y<=191; y++) for (let z=5; z<=7; z++) {
      await send(`setblock ${x} ${y} ${z} ${x === 10 && y === 190 && z === 6 ? 'minecraft:air' : 'gregtech:gt.blockcasings12'}`)
    }
    await send(`clear ${bot}`); await set(10, 'gregtech:gt.blockmachines 0 replace {mID:236s,mFacing:3s}'); await send(`give ${bot} minecraft:cactus 1`)
    await until('formed coke oven', async () => (await bridge.worldMachines(machine, { radius: 0 })).machines?.[0]?.formed, 15000)
    const { task, text, actual } = await processItems('controller-tank', { inputs: [{ id: 'minecraft:cactus', count: 1 }] })
    assert.equal(task.state, 'done', text); assert.equal(actual.after.find(f => f.fluid === 'creosote')?.amount, 30)
    assert.match(text, /fluid products[^;]*30 mB/); assert.match(text, /\+30 mB/); assert.match(text, /30 of 64000 mB/)
  })
} finally {
  try { if (switchSpawned) await bridge.botDespawn(operator); if (spawned) await bridge.botDespawn(bot) } finally { packdata.recipes?.close(); rcon.close(); client.stop() }
}
if (failures.length) throw new AggregateError(failures, 'process receipt acceptance')
