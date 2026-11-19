// Node 24, GTNH 2.9.0. From brain/: node test/live-gt-inputs.ts [scenario]
// Destructive fixture: use this checkout's disposable loopback server with private ports and packdata.
// Rebuilds (9..12,199..202,6..11), removes test-world item drops, replaces SlotsQA's inventory. No model/panel.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { BridgeClient } from '../src/bridge/client.ts'
import { BridgeApi } from '../src/bridge/api.ts'
import type { Item, TaskInfo } from '../src/bridge/protocol.ts'
import { RecipeBook } from '../src/packdata/recipes.ts'
import { ALL_TOOLS, runTool, type ToolContext } from '../src/tools/index.ts'
import { BRAIN_ROOT, REPO_ROOT, TESTSERVER_BRIDGE_PORT, TOKEN_FILE, openRcon, until } from './live-brain.ts'
import { RESERVED_PORTS } from './ports.ts'

const ts = path.join(REPO_ROOT, 'testserver')
const config = JSON.parse(fs.readFileSync(path.join(ts, 'config/aiplayer/aiplayer.json'), 'utf8'))
const props = fs.readFileSync(path.join(ts, 'server.properties'), 'utf8')
const rconPort = Number(/^rcon\.port=(\d+)$/m.exec(props)?.[1])
assert.ok(/^server-ip=127\.0\.0\.1$/m.test(props) && config.bridgeHost === '127.0.0.1', 'requires a loopback testserver')
assert.equal(TESTSERVER_BRIDGE_PORT, config.bridgePort, 'bridge must belong to this checkout')
assert.ok(rconPort > 0 && ![rconPort, config.bridgePort].some(p => RESERVED_PORTS.includes(p)), 'requires private test ports')
process.env.AIPLAYER_TEST_RCON_PORT = String(rconPort)
const bot = 'SlotsQA', machine = { x: 10, y: 200, z: 8 }, chest = { ...machine, x: 9 }
const gt = 'gregtech:gt.metaitem.01', machines = 'gregtech:gt.blockmachines'
const stack = (meta: number, count: number, id = gt): Item => ({ id, meta, count })
const raw = (n: number) => stack(2896,n), sulfur = (n: number) => stack(2022,n), mold = (n: number) => stack(32359,n)
const dir = path.join(BRAIN_ROOT, 'packdata'), recipes = RecipeBook.load(dir)?.book
assert.ok(recipes, 'needs this pack’s exported recipe book')
const client = new BridgeClient({ address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }), token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(), clientName: 'live-gt-inputs' })
const game = new BridgeApi(client), rc = await openRcon()
let started: TaskInfo | undefined
const ctx = { botName: bot, bridge: game, packdata: { dir, recipes }, hooks: { taskStarted: (t: TaskInfo) => { started = t } }, now: Date.now } as ToolContext
const failures: string[] = [], wanted = process.argv[2]
let ran = false
async function scenario(name: string, run: () => Promise<void>) {
  if (wanted && wanted !== name) return
  ran = true
  try { await run(); console.log(`PASS ${name}`) }
  catch (e) { failures.push(name); console.error(`FAIL ${name}:`, e) }
}
async function task(name: string, input: object, whileRunning?: () => Promise<void>) {
  const r = await runTool(ALL_TOOLS, ctx, name, input)
  assert.ok(!r.isError && started, r.content)
  const id = started.id; started = undefined
  await whileRunning?.()
  const t = await until(id, async () => (await game.taskList(bot)).recent?.find(t => t.id === id), 90000)
  console.log(JSON.stringify({ name, input, state: t.state, result: t.result, error: t.error?.code }))
  return t
}
async function give(...items: Item[]) {
  for (const s of items) await rc.send(`give ${bot} ${s.id} ${s.count} ${s.meta}`)
}
async function reset(mID: number, config = '') {
  await game.taskCancel(bot); await game.screenClose(bot)
  await rc.send(`tp ${bot} 10.5 200 10.5`)
  for (const [x,z] of [[10,8],[9,8],[10,7]]) await rc.send(`setblock ${x} 200 ${z} minecraft:air`)
  await rc.send(`setblock 9 200 8 minecraft:chest`)
  await rc.send(`setblock 10 200 8 ${machines} 0 replace {mID:${mID}s,mFacing:4s,mMainFacing:3${config}}`)
  // Replacing machines drops the previous scenario's contents. Do not allow the next case to pick them up.
  await rc.send('cofh killall item'); await rc.send(`clear ${bot}`)
}
async function open() {
  await game.screenOpen(bot, machine)
  return until('native machine screen', async () => { const s = await game.screenLook(bot); return s.slots?.some(x => x.role === 'input') && s.slots }, 5000)
}
async function readCircuit() {
  await open(); const s = await game.screenLook(bot); await game.screenClose(bot)
  return s.controls?.find(c => c.kind === 'circuit')?.value
}
async function manualPlace(kind: Item, role: string) {
  const slots = await open(), source = slots.find(s => s.own && s.item?.id === kind.id && s.item?.meta === kind.meta)
  const dest = slots.find(s => s.role === role && !s.item)
  assert.ok(source && dest, 'fixture needs item and empty ' + role)
  await game.screenClick(bot, {slot:source.slot}); const after = await game.screenClick(bot, {slot:dest.slot})
  assert.equal(after.cursor, undefined); assert.equal(after.slots?.find(s => s.slot === dest.slot)?.item?.count, kind.count)
  await game.screenClose(bot)
}
function stock(items: (Item | undefined)[]) {
  const counts: Record<string,number> = {}
  for (const s of items) if (s) { const key = s.id + '@' + (s.meta ?? 0); counts[key] = (counts[key] ?? 0) + s.count }
  return counts
}
async function checkState(input: Item[], bag: Item[], out: Item[] = [], special: Item[] = []) {
  const slots = await open(); await game.screenClose(bot)
  const items = (role: string) => stock(slots.filter(s => s.role === role).map(s => s.item))
  assert.ok(['input','output','special','battery'].every(role => slots.some(s => s.role === role)), 'fixture needs all four roles')
  const seen = { input: items('input'), special: items('special'), battery: items('battery'), output: items('output'),
    bag: stock((await game.botStatus(bot)).inventory ?? []), chest: stock((await game.worldContainers(chest,{radius:0})).containers?.[0]?.items ?? []) }
  console.log(JSON.stringify(seen))
  assert.deepEqual(seen,{ input: stock(input), special: stock(special), battery:{}, output:{}, bag:stock(bag), chest:stock(out) })
}
client.start()
try {
  await until('bridge', () => client.isConnected(), 12000)
  if (!(await game.botList()).bots?.some(b => b.name === bot && b.online)) await game.botSpawn({name:bot, ...machine})
  await rc.send(`tp ${bot} 10.5 200 10.5`)
  for (let x=9; x<=12; x++) for (let z=6; z<=11; z++) for (let y=199; y<=202; y++) await rc.send(`setblock ${x} ${y} ${z} minecraft:${y===199?'stone':'air'}`)
  for (const whole of [false,true]) await scenario(whole?'deposit-whole':'deposit-part', async () => {
    await reset(421, ',mWorks:1b'); await give(raw(whole?9:20), sulfur(whole?1:4))
    const t = await task('deposit_items',{container:machine,items:[raw(9),sulfur(1)]})
    await checkState([raw(9),sulfur(1)],whole?[]:[raw(11),sulfur(3)])
    assert.equal(t.result?.moved,10); assert.equal(t.state,'done')
  })
  await scenario('full', async () => {
    const dirt=stack(0,64,'minecraft:dirt'), stone=stack(0,64,'minecraft:cobblestone')
    await reset(421, ',mWorks:1b'); await give(dirt,stone); await manualPlace(dirt,'input'); await manualPlace(stone,'input')
    await give(raw(9),sulfur(4)); const t = await task('deposit_items',{container:machine,items:[raw(9),sulfur(1)]})
    await checkState([dirt,stone],[raw(9),sulfur(4)])
    assert.equal(t.error?.code,'container_full'); assert.equal(t.result?.moved,0)
  })
  await scenario('partial-load-refund', async () => {
    await reset(421); await give(raw(7)); await manualPlace(raw(7),'special'); await give(raw(5))
    const t = await task('process_items',{machine,inputs:[raw(9),sulfur(1)],wait:5})
    await checkState([], [raw(5)], [], [raw(7)]) // the refund is from INPUT, not the identical item in SPECIAL
    assert.equal(t.state,'failed'); assert.equal(t.result?.put,5)
    assert.deepEqual(stock(t.result?.notPut as Item[]),stock([raw(4),sulfur(1)]))
    assert.deepEqual(stock(t.result?.returnedInputs as Item[]),stock([raw(5)])); assert.deepEqual(t.result?.inputsNotReturned,[])
  })
  await scenario('no-room-refund', async () => {
    const sword = stack(0,1,'minecraft:wooden_sword')
    await reset(421); await give(raw(1), ...Array<Item>(35).fill(sword))
    const t = await task('process_items',{machine,inputs:[raw(1)],wait:5}, async () => {
      await until('raw rubber loaded', async () => (await game.worldContainers(machine,{radius:0})).containers?.[0]?.items?.some(i => i.meta===2896), 8000)
      await give(sword)
    })
    await checkState([raw(1)], [stack(0,36,sword.id)])
    assert.equal(t.state,'failed'); assert.deepEqual(t.result?.returnedInputs,[])
    assert.deepEqual(stock(t.result?.inputsNotReturned as Item[]),stock([raw(1)])); assert.match(String(t.result?.returnFailure),/inventory_full/)
  })
  await scenario('interrupted-open', async () => {
    await reset(213); await give(stack(23032,2))
    let atOpen: unknown
    const t = await task('process_items',{machine,inputs:[stack(23032,1)],circuit:1},async () => {
      const screen = await until('just-opened machine',async () => {
        const s = await game.screenLook(bot)
        return s.open && s.slots?.some(x => x.own && x.item?.meta === 23032) && s
      }, 5000, 0)
      atOpen = screen.controls?.find(c => c.kind === 'circuit')?.value
      await game.screenClose(bot) // player closes the newly opened screen before allowing an ingredient click
    })
    const after = await readCircuit()
    console.log(JSON.stringify({ atOpen, after }))
    assert.equal(t.state,'failed'); assert.equal(t.result?.put,0)
    await checkState([],[stack(23032,2)])
    assert.equal(atOpen,0,'circuit changed before the interrupted screen could be used'); assert.equal(after,0)
  })
  await scenario('empty-kit-resident', async () => {
    await reset(213, ',mStoredEnergy:32768L,mItemTransfer:1b')
    const rod = stack(23032,1)
    await give(rod); await manualPlace(rod,'input') // circuit 1 would use this resident rod to make a fence
    const t = await task('process_items',{machine,inputs:[raw(1)],circuit:1}) // no requested material is carried
    assert.equal(t.state,'failed'); assert.equal(t.result?.put,0)
    assert.equal(await readCircuit(),0); await checkState([rod],[])
  })
  await scenario('circuit-recipes', async () => {
    const rod = (n: number) => stack(23032,n), ring = (n: number) => stack(28032,n)
    await reset(213, ',mStoredEnergy:32768L,mItemTransfer:1b,mFluid:{FluidName:"molten.plastic",Amount:21852}')
    await give(rod(1))
    const fence = stack(0,1,'gregtech:gt.blockfencemetal')
    const first = await task('process_items',{machine,circuit:1,inputs:[rod(1)],expect:[fence]})
    assert.equal(first.state,'done'); await checkState([],[],[fence])
    assert.equal(await readCircuit(),0,'original none restored')
    await open()
    const control = (await game.screenLook(bot)).controls?.find(c => c.kind === 'circuit'); assert.ok(control)
    await game.screenSet(bot,{panel:control.panel,key:control.key,value:1}); await game.screenClose(bot)
    await give(rod(5),ring(4))
    const leave = await task('process_items',{machine,recipe:109339,rounds:2,leave:true}) // requires circuit none
    assert.equal(leave.state,'done'); assert.equal(leave.result?.left,true)
    await until('two wheels delivered and leave circuit restored to 1',async () => {
      const output = (await game.worldContainers(chest,{radius:0})).containers?.[0]?.items ?? []
      return output.some(i => i.meta===32100 && i.count===2) && (await game.worldMachines(machine,{radius:0})).machines?.[0]?.circuit===1
    }, 30000)
    await checkState([], [rod(3)], [fence,stack(32100,2)])
  })
  await scenario('reactor', async () => {
    await reset(421, ',mStoredEnergy:2048L')
    await rc.send(`setblock 10 200 7 ${machines} 0 replace {mID:771s,mFacing:3s,mStoredEnergy:40000L}`)
    await give(raw(20),sulfur(4))
    const t = await task('process_items',{machine,recipe:158915,rounds:1,wait:60})
    await checkState([],[raw(11),sulfur(3)])
    assert.equal(t.state,'done'); assert.equal(t.result?.put,10)
    const tanks = (await game.worldBlock(machine)).tanks; console.log(JSON.stringify({tanks}))
    assert.equal(tanks?.find(f=>f.fluid==='molten.rubber')?.amount,1296)
  })
  await scenario('shape-and-pipes', async () => {
    await reset(282, ',mStoredEnergy:8192L,mItemTransfer:1b'); await give(mold(2), stack(11300,8))
    const place = await task('deposit_items',{container:machine,items:[mold(1)]})
    await checkState([mold(1)], [mold(1),stack(11300,8)]); assert.equal(place.state,'done')
    const t = await task('process_items',{machine,recipe:214392,rounds:3,moldInside:true,wait:20})
    await checkState([mold(1)], [mold(1),stack(11300,5)], [stack(5121,3,machines)])
    assert.equal(t.state,'done'); assert.equal(t.result?.put,3)
  })
  await scenario('chest', async () => {
    await reset(421); await give(raw(20),sulfur(1)); const t = await task('deposit_items',{container:chest,items:[raw(9),sulfur(1)]})
    await checkState([], [raw(11)], [raw(9),sulfur(1)]); assert.equal(t.result?.moved,10); assert.equal(t.state,'done')
  })
  await scenario('cover', async () => {
    await reset(421); await rc.send(`tp ${bot} 12.5 200 8.5`); await give(stack(32380,1),mold(2))
    await task('use_item',{id:gt,meta:32380,on:machine,side:'east',sneak:true,approach:'current'})
    const container = {...machine,side:'east',sneak:true}
    const cover = async () => (await game.worldBlock(machine)).covers?.find(c => c.side === 'east')
    assert.equal((await cover())?.meta,32380,'real item holder on the east face')
    const d = await task('deposit_items',{container,items:[mold(1)]})
    assert.equal(d.result?.moved,1); assert.deepEqual(stock((await cover())?.items ?? []),stock([mold(1)]))
    const w = await task('withdraw_items',{container,items:[mold(1)]})
    assert.equal(w.result?.moved,1); assert.deepEqual(stock((await cover())?.items ?? []),{})
    assert.deepEqual(stock((await game.botStatus(bot)).inventory ?? []),stock([mold(2)]))
  })
  await scenario('controller', async () => {
    await reset(421)
    for (let x=9; x<=11; x++) for (let z=6; z<=8; z++) for (let y=200; y<=202; y++)
      await rc.send(`setblock ${x} ${y} ${z} ${x===10 && y===201 && z===7 ? 'minecraft:air' : 'gregtech:gt.blockcasings12'}`)
    await rc.send(`setblock 10 201 8 ${machines} 0 replace {mID:236s,mFacing:3s}`)
    await give(stack(0,8,'minecraft:log'))
    const t = await task('process_items',{machine:{...machine,y:201},inputs:[stack(0,4,'minecraft:log')],leave:true})
    assert.equal(t.state,'done'); assert.equal(t.result?.put,4); assert.deepEqual(stock((await game.botStatus(bot)).inventory ?? []),stock([stack(0,4,'minecraft:log')]))
  })
} finally {
  if (client.isConnected()) { await game.taskCancel(bot).catch(()=>{}); await game.screenClose(bot).catch(()=>{}); await game.botDespawn(bot).catch(()=>{}) }
  client.stop(); rc.close(); recipes.close()
}
assert.ok(ran,'unknown scenario'); assert.deepEqual(failures,[])
