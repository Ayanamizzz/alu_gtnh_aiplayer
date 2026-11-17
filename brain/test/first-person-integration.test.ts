import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { FirstPersonRenderer } from '../src/vision/renderer.ts'
import { chromeExecutable } from '../src/vision/chrome-pipe.ts'
import type { FirstPersonSnapshot } from '../src/bridge/protocol.ts'
import { PictureStore, pictureMediaType } from '../src/store/pictures.ts'
import type { GenerateRequest, ToolResultPart } from '../src/llm/index.ts'
import { runTool, ALL_TOOLS } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/index.ts'
import { BridgeApi } from '../src/bridge/api.ts'
import { FakeGame, lineCalls, makeAgent, reply } from './agent-harness.ts'
import { encodePng, tmpDir, waitFor, worldBlocksAnswer } from './helpers.ts'

let executable: string | undefined
try { executable = await chromeExecutable() } catch { /* Chrome is optional for all other brain functions. */ }

const snapshot: FirstPersonSnapshot = {
  version: 1, bot: 'Alu', dim: 0, tick: 12345, time: 6000, capturedAt: 1_700_000_000_000,
  camera: { eye: { x: 0.5, y: 1.62, z: 0.5 }, look: { x: 0, y: 0, z: 1 }, yaw: 0, pitch: 0 },
  blocks: worldBlocksAnswer({ x1: -2, y1: 0, z1: -2, x2: 2, y2: 4, z2: 2 }, { '0,1,2': 'minecraft:stone', '1,1,2': 'minecraft:stone' }) as unknown as FirstPersonSnapshot['blocks'],
}
const results = (request: GenerateRequest): ToolResultPart[] => request.messages.flatMap(message => message.role === 'user' ? message.content.filter(part => part.type === 'tool_result') : [])

test('view_area eyes rejects contradictory cameras and unconfigured or canceled calls without issuing a game action', async () => {
  const game = new FakeGame()
  const controller = new AbortController(); controller.abort()
  const ctx = { botName: 'Alu', bridge: new BridgeApi(game) } as ToolContext
  assert.match((await runTool(ALL_TOOLS, ctx, 'view_area', { view: 'eyes' })).content, /unavailable/)
  assert.match((await runTool(ALL_TOOLS, ctx, 'view_area', { view: 'eyes', x1: 0 })).content, /only radius/)
  assert.match((await runTool(ALL_TOOLS, ctx, 'view_area', { view: 'eyes', radius: 32 })).content, /<= 31/)
  const neverRender = { render: async () => { throw new Error('must not render') } }
  const canceled = await runTool(ALL_TOOLS, { ...ctx, firstPerson: neverRender, signal: controller.signal }, 'view_area', { view: 'eyes' })
  assert.equal(canceled.isError, true)
  assert.match(canceled.content, /canceled/)
  assert.deepEqual(game.callsOf('bot.snapshot'), [])
  assert.deepEqual(game.callsOf('task.start'), [])
})

test('the configured eye-observation deadline includes waiting for the server snapshot', async (t) => {
  const before = process.env.AIPLAYER_VIEW_TIMEOUT_MS
  process.env.AIPLAYER_VIEW_TIMEOUT_MS = '5'
  t.after(() => { if (before === undefined) delete process.env.AIPLAYER_VIEW_TIMEOUT_MS; else process.env.AIPLAYER_VIEW_TIMEOUT_MS = before })
  const game = new FakeGame()
  game.handlers['bot.snapshot'] = async () => { await new Promise(resolve => setTimeout(resolve, 30)); return structuredClone(snapshot) }
  let rendered = false
  const ctx = { botName: 'Alu', bridge: new BridgeApi(game), firstPerson: { render: async () => { rendered = true; throw new Error('snapshot did not arrive within the deadline') } } } as unknown as ToolContext
  const result = await runTool(ALL_TOOLS, ctx, 'view_area', { view: 'eyes', radius: 0 })
  assert.equal(result.isError, true)
  assert.match(result.content, /timed out after 0\.005 seconds/)
  assert.deepEqual(game.callsOf('bot.snapshot'), [{ bot: 'Alu', radius: 0 }])
  assert.equal(rendered, false)
  assert.equal(result.images, undefined)
})

test('both lines and a real helper send the rendered JPEG to their model and retain the same image for the panel', { skip: !executable, timeout: 90_000 }, async (t) => {
  const tmp = tmpDir('eyes-integration-')
  const atlas = path.join(tmp.dir, 'atlas.png')
  fs.writeFileSync(atlas, encodePng({ width: 16, height: 16, rgba: Buffer.from(Array.from({ length: 16 * 16 }, () => [110, 120, 130, 255]).flat()) }))
  const renderer = new FirstPersonRenderer({ dir: tmp.dir, textures: { file: atlas, tile: 16, columns: 1, rows: 1, tiles: new Map([['stone', 0]]), version: 'fixture' } }, { executable })
  const pictures = new PictureStore(tmp.dir)
  const h = makeAgent({ dir: tmp.dir, firstPerson: renderer, pictures, vision: true, helper: true })
  t.after(async () => { await Promise.all([h.agent.stop(), renderer.close()]); tmp.cleanup() })
  h.game.handlers['bot.snapshot'] = () => structuredClone(snapshot)
  // Cold-start timing belongs to the actual renderer, not the harness's short model wait budget.
  const native = await renderer.render(snapshot)
  assert.equal(pictureMediaType(native.jpeg), 'image/jpeg')
  for (const line of ['talk', 'work'] as const) {
    const model = line === 'talk' ? h.talk : h.llm
    const before = model.requests.length
    const out = await lineCalls(h, line, 'view_area', { view: 'eyes', radius: 12 })
    assert.equal(out.isError, false, out.content)
    assert.match(out.content, /tick 12345/)
    assert.match(out.content, /captured box/)
    assert.match(out.content, /pipes\/machines can appear as solid cubes/)
    const seen = results(model.requests[before + 1]!).find(result => result.images?.length)
    assert.equal(seen?.images?.[0]?.mediaType, 'image/jpeg')
    assert.ok(Buffer.from(seen!.images![0]!.data, 'base64').equals(native.jpeg))
  }
  h.helper!.enqueue(reply('', [{ name: 'view_area', input: { view: 'eyes' } }]), reply('I received the frozen eye-level observation.'))
  assert.equal((await lineCalls(h, 'talk', 'start_helper', { task: 'Inspect the current eye-level image; do not act.' })).isError, false)
  await waitFor('helper receives the eye-level JPEG', () => h.agent.helperOverview().recent.find(row => row.id === 'h1'), 10_000)
  await h.agent.whenIdle()
  assert.equal(results(h.helper!.requests[1]!).find(result => result.images?.length)?.images?.[0]?.mediaType, 'image/jpeg')
  const entries = h.log.recent(0, 500).filter(entry => entry.who === 'view_area' && entry.pictures?.length)
  assert.equal(entries.length, 3)
  for (const entry of entries) {
    const id = entry.pictures![0]!
    assert.equal(pictureMediaType(pictures.get(id)!), 'image/jpeg')
    assert.deepEqual(pictures.get(id), native.jpeg)
    assert.equal(pictures.blocks(id), undefined, 'first-person still is not an orbit scene')
  }
  for (const method of ['task.start', 'bot.look', 'bot.command', 'screen.click']) assert.deepEqual(h.game.callsOf(method), [])
  assert.deepEqual(h.game.callsOf('bot.snapshot').map(call => [call.bot, call.radius]), [['Alu', 12], ['Alu', 12], ['Alu', 12]])
  assert.equal(fs.readFileSync(path.join(tmp.dir, 'history.json'), 'utf8').includes(native.jpeg.toString('base64')), false)
})
