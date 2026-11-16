// Opt-in acceptance on a copied test world only. No model/config loading or building edits.
// PROBE_OUT=/tmp/aip/first-person-base-angles node brain/test/live-first-person-base.ts --survey
// PROBE_OUT=... node brain/test/live-first-person-base.ts --plan /absolute/plan.json
// --watch keeps this one renderer warm until OUT/finish exists; consumes OUT/queue/*.json.
// --audit writes material/shape provenance for saved snapshots offline (no bridge or Chrome).
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
import { FirstPersonRenderer, snapshotScene } from '../src/vision/renderer.ts'
import type { SnapshotPicture } from '../src/vision/renderer.ts'
import { decodePng } from '../src/design/index.ts'
import { gridFromBlocks } from '../src/render/index.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import { looksFor } from '../src/tools/pictures.ts'
import type { ToolContext } from '../src/tools/types.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = process.env.PROBE_OUT ?? '/tmp/aip/first-person-base-angles'
const BOT = 'VisionProbe'
const execute = promisify(execFile)
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
type Position = { x: number; y: number; z: number }
type Shot = { name: string; purpose: string; yaw: number; pitch: number; radius?: number }
type Site = { name: string; feet: Position; shots: Shot[] }

async function loadPack(): Promise<PackData> {
  const dir = path.join(ROOT, 'brain/packdata')
  const blocks = (await fs.readFile(path.join(dir, 'blocks.jsonl'), 'utf8')).trim().split('\n').map(line => parseBlockColor(JSON.parse(line))).filter(b => b !== undefined)
  const textures = parseAtlas(JSON.parse(await fs.readFile(path.join(dir, 'textures/atlas.json'), 'utf8')), path.join(dir, 'textures/atlas.png'))
  return { dir, blocks, textures }
}

await fs.mkdir(OUT, { recursive: true })
if (process.argv.includes('--audit')) {
  const packdata = await loadPack(), looks = looksFor(packdata)
  const missing = new Map<string, unknown>()
  for (const file of (await fs.readdir(OUT)).filter(n => /^\d\d-[^.]+\.json$/.test(n)).sort()) {
    const { snapshot } = JSON.parse(await fs.readFile(path.join(OUT, file), 'utf8')) as { snapshot: FirstPersonSnapshot }
    if (!snapshot) continue
    const grid = gridFromBlocks(snapshot.blocks), { scene } = snapshotScene(snapshot, packdata)
    const kinds = scene.kinds.flatMap((kind, i) => {
      if (!kind) return []
      const look = looks.of(grid.kinds[i])
      const shapeSource = look.source === 'hash'
        ? `BlockLooks.find: ${kind.shape === 'full' ? 'no SHAPES name match; full cube fallback' : 'SHAPES name-regexp heuristic'}`
        : `BlockLooks.find: ${look.source === 'builtin' ? 'BUILTIN/ALIASES' : look.source === 'guess' ? 'GUESSES name-regexp heuristic' : 'colour table/ALIASES (not geometry data)'}`
      const appearance = { key: kind.key, capturedCells: kind.count, shape: kind.shape, shapeSource, geometrySource: `brain/src/panel/public/viewer3d.js: BOXES.${kind.shape}`, lookSource: look.source, alpha: kind.alpha, cutout: kind.cutout ?? false, missingTexture: kind.tex === undefined, textureName: look.tex ?? null, textureTopName: look.texTop ?? null, atlasIndex: kind.tex ?? null, hasDynamicTileEntityData: false }
      if (appearance.missingTexture) missing.set(kind.key, { ...appearance, capturedCells: undefined })
      return [appearance]
    })
    await fs.writeFile(path.join(OUT, file.replace('.json', '.appearance.json')), JSON.stringify({ snapshotFile: file, countMeaning: 'Counts within the entire captured box, not screen-visible pixels', kinds }, null, 2))
  }
  await fs.writeFile(path.join(OUT, 'missing-textures-and-shapes.json'), JSON.stringify([...missing.values()], null, 2))
  console.log(`Offline appearance audit saved; ${missing.size} missing-texture kinds across all saved snapshots`)
  process.exit(0)
}
const properties = await fs.readFile(path.join(ROOT, 'testserver/server.properties'), 'utf8')
for (const line of ['server-ip=127.0.0.1', 'server-port=10486', 'rcon.port=25607', 'level-name=World-base-probe']) {
  assert.ok(properties.split(/\r?\n/).includes(line), `Isolated base-probe world required: ${line}`)
}
const token = (await fs.readFile(path.join(ROOT, 'testserver/config/aiplayer/bridge-token.txt'), 'utf8')).trim()
const client = new BridgeClient({ address: () => ({ host: '127.0.0.1', port: 25622 }), token: () => token, clientName: 'first-person-base-angles', requestTimeoutMs: 15000 })
const game = new BridgeApi(client)
let renderer: FirstPersonRenderer | undefined
let created = false
const records: unknown[] = []
const commandLog: unknown[] = []

async function place(feet: Position) {
  // Only this newly created bot, only the isolated RCON endpoint, and only teleport (no setblock).
  const command = `tp ${BOT} ${feet.x.toFixed(3)} ${feet.y.toFixed(3)} ${feet.z.toFixed(3)}`
  const result = await execute('python3', [path.join(ROOT, 'tools/rcon.py'), '--host', '127.0.0.1', '--port', '25607', '--password-file', path.join(ROOT, 'testserver/.rcon-password'), command])
  assert.match(result.stdout, /Teleported/)
  commandLog.push({ at: new Date().toISOString(), command, response: result.stdout.trim() })
  const until = Date.now() + 6000
  let stable = 0
  while (Date.now() < until) {
    const status = await game.botStatus(BOT)
    const p = status.pos
    if (p && Math.abs(p.x - feet.x) < 0.01 && Math.abs(p.y - feet.y) < 0.01 && Math.abs(p.z - feet.z) < 0.01) stable++
    else stable = 0
    if (stable >= 4) return
    await sleep(100)
  }
  throw new Error(`Bot did not settle at requested floor: ${JSON.stringify(await game.botStatus(BOT))}`)
}

async function survey() {
  for (const site of [
    { name: 'storage', feet: { x: -535.5, y: 69, z: 44.5 } },
    { name: 'campus', feet: { x: -638.5, y: 69, z: 100.5 } },
  ]) {
    await place(site.feet)
    const { x, y, z } = site.feet
    const blocks = await game.worldBlocks({ dim: 0, x1: Math.floor(x) - 20, y1: y - 3, z1: Math.floor(z) - 20, x2: Math.floor(x) + 20, y2: y + 17, z2: Math.floor(z) + 20 })
    await fs.writeFile(path.join(OUT, `survey-${site.name}.json`), JSON.stringify({ site, at: new Date().toISOString(), blocks }, null, 2))
    console.log(`Survey ${site.name}: saved 41×21×41 bounded world.blocks`)
  }
  // Four bounded, read-only surface scans locate existing buildings; no world generation or edits.
  for (const x1 of [-640, -576]) for (const z1 of [0, 64]) {
    const scan = await game.worldScan({ dim: 0, x1, z1, x2: x1 + 63, z2: z1 + 63 })
    await fs.writeFile(path.join(OUT, `scan-${x1}-${z1}.json`), JSON.stringify(scan, null, 2))
  }
}

async function capture(plans: Site[]) {
  renderer ??= new FirstPersonRenderer(await loadPack())
  let lastPicture: SnapshotPicture | undefined
  const firstPerson: Pick<FirstPersonRenderer, 'render'> = { render: async (snapshot, options) => { lastPicture = await renderer!.render(snapshot, options); return lastPicture } }
  const ctx = { bridge: game, botName: BOT, firstPerson, canSeeImages: () => true, now: Date.now } as ToolContext
  for (const site of plans) {
    assert.ok(site.shots.length > 0)
    await place(site.feet)
    const floor = await game.worldBlocks({ dim: 0, x1: Math.floor(site.feet.x), x2: Math.floor(site.feet.x), y1: site.feet.y - 1, y2: site.feet.y + 1, z1: Math.floor(site.feet.z), z2: Math.floor(site.feet.z) })
    const grid = gridFromBlocks(floor)
    const stand = [...grid.cells].map(i => grid.kinds[i])
    assert.notEqual(stand[0].id, 'minecraft:air', 'Needs actual floor support')
    assert.equal(stand[1].id, 'minecraft:air', 'Feet must be in air')
    assert.equal(stand[2].id, 'minecraft:air', 'Head must be in air')
    let firstCamera: FirstPersonSnapshot['camera'] | undefined
    for (const shot of site.shots) {
      assert.match(shot.name, /^[a-zA-Z0-9_-]+$/)
      assert.equal(await fs.access(path.join(OUT, `${shot.name}.json`)).then(() => true, () => false), false, 'Do not overwrite evidence')
      const eye = { ...site.feet, y: site.feet.y + 1.62 }
      const yaw = shot.yaw * Math.PI / 180, pitch = shot.pitch * Math.PI / 180
      // bot.look targets a block centre, not direct yaw/pitch. Large distance limits integer quantization.
      const distance = 40
      const target = {
        x: Math.round(eye.x - Math.sin(yaw) * Math.cos(pitch) * distance - 0.5),
        y: Math.round(eye.y - Math.sin(pitch) * distance - 0.5),
        z: Math.round(eye.z + Math.cos(yaw) * Math.cos(pitch) * distance - 0.5),
      }
      await game.botLook(BOT, target)
      const result = await runTool(ALL_TOOLS, ctx, 'view_area', { view: 'eyes', radius: shot.radius ?? 16 })
      assert.ok(!result.isError, result.content)
      assert.equal(result.images?.length, 1)
      assert.equal(result.images[0].mediaType, 'image/jpeg')
      const data = result.data as { snapshot: FirstPersonSnapshot; [key: string]: unknown }
      const snapshot = data.snapshot, pic = lastPicture!
      assert.ok(Math.abs(snapshot.camera.pitch - shot.pitch) < 2, 'Actual pitch differs from requested look')
      const yawError = ((snapshot.camera.yaw - shot.yaw + 540) % 360) - 180
      assert.ok(Math.abs(yawError) < 2, 'Actual yaw differs from requested look')
      if (firstCamera) assert.deepEqual(snapshot.camera.eye, firstCamera.eye, 'All shots at a site must use the same real eye')
      else firstCamera = snapshot.camera
      const png = decodePng(pic.png)
      assert.deepEqual([png.width, png.height], [512, 288])
      await fs.writeFile(path.join(OUT, `${shot.name}.png`), pic.png)
      await fs.writeFile(path.join(OUT, `${shot.name}.jpg`), result.images[0].data)
      await fs.writeFile(path.join(OUT, `${shot.name}.json`), JSON.stringify({ ...data, site, shot, lookTarget: target, standingBlocks: stand, toolResultContent: result.content }, null, 2))
      const { snapshot: _snapshot, ...metrics } = data
      const record = { name: shot.name, purpose: shot.purpose, site: site.name, ...metrics, camera: snapshot.camera, dim: snapshot.dim, tick: snapshot.tick, capturedAt: snapshot.capturedAt, worldTime: snapshot.time, bounds: { x: snapshot.blocks.x, y: snapshot.blocks.y, z: snapshot.blocks.z, sx: snapshot.blocks.sx, sy: snapshot.blocks.sy, sz: snapshot.blocks.sz, unloaded: snapshot.blocks.unloaded }, pngSha256: hash(pic.png), jpegSha256: hash(result.images[0].data), coldStartMs: renderer.coldStartMs, startupMs: renderer.startupMs }
      records.push(record)
      await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify({ records, modelInvoked: false }, null, 2))
      console.log(JSON.stringify(record))
    }
  }
}

try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated bridge not ready')), 15000)
    client.onReady(() => { clearTimeout(timer); resolve() }); client.start()
  })
  await fs.writeFile(path.join(OUT, 'server-hello.json'), JSON.stringify(client.status().hello, null, 2))
  const bots = await game.botList()
  assert.ok(!(bots.bots ?? []).some(b => b.online), 'Copied bots must be disabled before startup')
  await game.botSpawn({ name: BOT, dim: 0, x: -535, y: 69, z: 44 })
  created = true
  await game.botConfigure(BOT, { invulnerable: true, hunger: false })
  await game.taskCancel(BOT)
  if (process.argv.includes('--survey')) await survey()
  else if (process.argv.includes('--watch')) {
    const queue = path.join(OUT, 'queue')
    await fs.mkdir(queue, { recursive: true })
    const consumed = new Set<string>()
    const deadline = Date.now() + 30 * 60 * 1000
    while (Date.now() < deadline) {
      for (const name of (await fs.readdir(queue)).filter(n => n.endsWith('.json')).sort()) {
        if (consumed.has(name)) continue
        await capture(JSON.parse(await fs.readFile(path.join(queue, name), 'utf8')))
        consumed.add(name)
        await fs.writeFile(path.join(OUT, `${name}.done`), new Date().toISOString())
      }
      if (await fs.access(path.join(OUT, 'finish')).then(() => true, () => false)) break
      await sleep(250)
    }
  } else {
    const planAt = process.argv.indexOf('--plan')
    assert.ok(planAt !== -1 && process.argv[planAt + 1], 'Supply --survey, --plan FILE, or --watch')
    await capture(JSON.parse(await fs.readFile(process.argv[planAt + 1], 'utf8')))
  }
} finally {
  try {
    if (created) await game.botDespawn(BOT)
    await fs.writeFile(path.join(OUT, 'own-bots-after.json'), JSON.stringify(await game.botList().catch(() => ({ unavailable: true })), null, 2))
    await fs.writeFile(path.join(OUT, 'rcon-commands.json'), JSON.stringify(commandLog, null, 2))
  } finally {
    client.stop()
    await renderer?.close()
  }
  console.log('Closed probe: own bot despawned, private Chrome/HTTP closed; no model invoked')
}
