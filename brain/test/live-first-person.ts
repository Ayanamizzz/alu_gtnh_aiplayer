// Opt-in real world probe. Run via tools/first-person-probe run; no LLM/network credentials loaded.
// Offline frozen replay: tools/first-person-probe replay SNAPSHOT.json OUTPUT.png
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import type { FirstPersonSnapshot } from '../src/bridge/protocol.ts'
import { parseAtlas } from '../src/packdata/textures.ts'
import { parseBlockColor } from '../src/packdata/blocks.ts'
import type { PackData } from '../src/packdata/index.ts'
import { FirstPersonRenderer, firstPersonTool } from '../src/experimental/first-person.ts'
import type { SnapshotPicture } from '../src/experimental/first-person.ts'
import { decodePng } from '../src/design/index.ts'
import { gridFromBlocks } from '../src/render/index.ts'
import { runTool } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/types.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = process.env.PROBE_OUT ?? '/tmp/aip/first-person-probe'
const BOT = 'VisionProbe'
const execute = promisify(execFile)
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function pack(): Promise<PackData> {
  const dir = path.join(ROOT, 'brain/packdata')
  const blocks = (await fs.readFile(path.join(dir, 'blocks.jsonl'), 'utf8')).trim().split('\n').map(line => parseBlockColor(JSON.parse(line))).filter(b => b !== undefined)
  const textures = parseAtlas(JSON.parse(await fs.readFile(path.join(dir, 'textures/atlas.json'), 'utf8')), path.join(dir, 'textures/atlas.png'))
  return { dir, blocks, textures }
}
const packdata = await pack()
const renderer = new FirstPersonRenderer(packdata)
if (process.argv[2] === '--replay') {
  try {
    const raw = JSON.parse(await fs.readFile(process.argv[3], 'utf8'))
    const snapshot: FirstPersonSnapshot = raw.snapshot ?? raw
    const pic = await renderer.render(snapshot)
    await fs.writeFile(process.argv[4], pic.png)
    console.log(JSON.stringify({ png: process.argv[4], sha256: hash(pic.png), renderMs: pic.renderMs, phasesMs: pic.phasesMs, renderCallMs: pic.renderCallMs, startupMs: renderer.startupMs }))
  } finally { await renderer.close() }
} else {
  await fs.mkdir(OUT, { recursive: true })
  const properties = await fs.readFile(path.join(ROOT, 'testserver/server.properties'), 'utf8')
  assert.match(properties, /^server-port=10486$/m)
  assert.match(properties, /^rcon.port=25607$/m)
  const token = (await fs.readFile(path.join(ROOT, 'testserver/config/aiplayer/bridge-token.txt'), 'utf8')).trim()
  const client = new BridgeClient({ address: () => ({ host: '127.0.0.1', port: 25622 }), token: () => token, clientName: 'first-person-probe', requestTimeoutMs: 15000 })
  const game = new BridgeApi(client)
  const fixture = async (action: string) => {
    const result = await execute('python3', [path.join(ROOT, 'tools/first-person-fixture.py'), action], { timeout: 300000 })
    console.log(result.stdout.trim())
  }
  let lastPicture: SnapshotPicture | undefined
  const tool = firstPersonTool({ render: async snapshot => { lastPicture = await renderer.render(snapshot); return lastPicture } })
  // Only the fields consumed by this query-only tool; no agent loop, owner session or model configuration.
  const ctx = { bridge: game, botName: BOT, packdata, canSeeImages: () => true, now: Date.now } as ToolContext
  const results: unknown[] = []
  async function take(name: string) {
    // This is the actual brain tool dispatch path, simulating only the model's choice to look.
    const result = await runTool([tool], ctx, tool.name, { radius: 12 })
    assert.ok(!result.isError, result.content)
    assert.equal(result.images?.length, 1)
    assert.equal(result.images[0].mediaType, 'image/jpeg')
    assert.equal(result.images[0].blocks, undefined) // It is the model's picture, not a panel-only 3D payload.
    const data = result.data as { snapshot: FirstPersonSnapshot; [key: string]: unknown }
    const pic = lastPicture!
    const png = decodePng(pic.png)
    assert.deepEqual([png.width, png.height], [512, 288])
    assert.ok(png.rgba.some(v => v !== png.rgba[0]))
    await fs.writeFile(path.join(OUT, `${name}.png`), pic.png)
    await fs.writeFile(path.join(OUT, `${name}.jpg`), result.images[0].data)
    await fs.writeFile(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2))
    const { snapshot, ...metrics } = data
    const record = { name, ...metrics, coldStartMs: renderer.coldStartMs, startupMs: renderer.startupMs, pngSha256: hash(pic.png), snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)), camera: snapshot.camera, tick: snapshot.tick, content: result.content }
    results.push(record)
    console.log(JSON.stringify(record))
    return { snapshot, png: pic.png }
  }
  const leafCount = (snapshot: FirstPersonSnapshot) => {
    const grid = gridFromBlocks(snapshot.blocks)
    return [...grid.cells].filter(i => grid.kinds[i]?.id === 'minecraft:leaves').length
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated bridge not ready')), 15000)
      client.onReady(() => { clearTimeout(timer); resolve() })
      client.start()
    })
    await fs.writeFile(path.join(OUT, 'server-hello.json'), JSON.stringify(client.status().hello, null, 2))
    console.log(`Connected isolated mod ${client.status().hello?.modVersion}`)
    await game.botSpawn({ name: BOT, dim: 0, x: 6, y: 181, z: 5 })
    await game.botConfigure(BOT, { invulnerable: true, hunger: false })
    await game.taskCancel(BOT)
    await fixture('build')
    // 1.7's tp puts integer y at y+0.5; wait for the real bot to land before the paired observations.
    const settleUntil = Date.now() + 5000
    while (true) {
      const status = await game.botStatus(BOT)
      if (status.online && status.pos && Math.abs(status.pos.y - 181) < 0.001) break
      if (Date.now() > settleUntil) throw new Error('Fixture bot did not settle on the floor')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await game.botLook(BOT, { x: 6, y: 182, z: 12 })
    const leaves = await take('01-leaves')
    assert.ok(leafCount(leaves.snapshot) >= 18)
    assert.equal(leaves.snapshot.camera.eye.x, 6.5)
    assert.equal(leaves.snapshot.camera.eye.z, 5.5)
    assert.ok(Math.abs(leaves.snapshot.camera.eye.y - 182.62) < 0.01)
    assert.ok(leaves.snapshot.camera.look.z > 0.99)
    const serialized = JSON.stringify(leaves.snapshot)
    await fixture('clean')
    const clean = await take('02-clean')
    assert.deepEqual(clean.snapshot.camera, leaves.snapshot.camera)
    assert.equal(leafCount(clean.snapshot), 0)
    assert.notEqual(hash(clean.png), hash(leaves.png))
    await game.botLook(BOT, { x: 6, y: 182, z: 0 })
    const wall = await take('03-wall')
    assert.ok(wall.snapshot.camera.look.z < -0.99)
    assert.notEqual(hash(wall.png), hash(clean.png))
    // Change actual hidden blocks: they are captured but the solid wall must hide the change.
    await fixture('hidden')
    const hidden = await take('04-hidden-change')
    assert.notDeepEqual(hidden.snapshot.blocks, wall.snapshot.blocks)
    assert.equal(hash(hidden.png), hash(wall.png))
    // World and head have changed; an old raw snapshot is nevertheless a reproducible frozen photograph.
    const frozen = await renderer.render(leaves.snapshot)
    assert.equal(hash(frozen.png), hash(leaves.png))
    assert.equal(JSON.stringify(leaves.snapshot), serialized)
    await fs.writeFile(path.join(OUT, '05-frozen-replay.png'), frozen.png)
    await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify({ results, checks: { realToolDispatch: true, sameEyeCleanComparison: true, newRequestSeesChange: true, hiddenChangesOccluded: true, oldSnapshotAfterWorldAndLookChanged: true }, frozenSha256: hash(frozen.png), modelInvoked: false }, null, 2))
    console.log('PASS: live tool images, same-eye clean comparison, solid-wall occlusion, frozen replay')
  } finally {
    await game.botDespawn(BOT).catch(() => {})
    client.stop()
    await renderer.close()
  }
}
