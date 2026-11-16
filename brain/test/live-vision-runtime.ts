// Offline opt-in: node brain/test/live-vision-runtime.ts SNAPSHOT.json [OUTPUT_DIR]
// Uses installed Chrome + local packdata; never opens a game/bridge connection or model key.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import type { FirstPersonSnapshot } from '../src/bridge/protocol.ts'
import { decodePng } from '../src/design/index.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { chromeExecutable } from '../src/vision/chrome-pipe.ts'
import type { SnapshotPicture } from '../src/vision/renderer.ts'
import { assertReleased, fixture, until } from './fixture-vision.ts'

const file = process.argv[2]
if (!file) throw new Error('Give a frozen snapshot JSON file; no live game reads are performed')
const raw = JSON.parse(await readFile(file, 'utf8'))
const snapshot: FirstPersonSnapshot = raw.snapshot ?? raw
const output = path.resolve(process.argv[3] ?? '/tmp/aip/vision-final/runtime')
await mkdir(output, { recursive: true })
const executable = await chromeExecutable(process.env.AIPLAYER_VIEW_CHROME)
const pack = loadPackData(new URL('../packdata/', import.meta.url).pathname)
const records: object[] = []

function opaque(picture: SnapshotPicture): void {
  const { width, height, rgba } = decodePng(picture.png)
  assert.deepEqual([width, height], [512, 288])
  for (let at = 3; at < rgba.length; at += 4) assert.equal(rgba[at], 255, `pixel alpha at ${at}`)
  assert.equal(picture.jpeg.subarray(0, 2).toString('hex'), 'ffd8')
  assert.equal(picture.jpeg.subarray(-2).toString('hex'), 'ffd9')
}

await test('real Chrome renders frozen observations and recovers after lifecycle failures', { timeout: 240_000 }, async t => {
  t.after(() => pack.recipes?.close())
  const f = await fixture(t, 'exit', pack)
  const r = f.renderer
  const render = async (label: string) => {
    const picture = await r.render(snapshot)
    opaque(picture)
    const { png, jpeg, ...info } = picture
    records.push({ label, ...info, coldStartMs: r.coldStartMs, startupMs: { ...r.startupMs } })
    return picture
  }

  await t.test('an exited startup is recoverable; real cold and warm PNGs are identical and opaque', async () => {
    await assert.rejects(r.render(snapshot), /Chrome (exited|CDP pipe closed)/)
    await assertReleased((await f.launches()).at(-1)!)
    await f.mode(`real:${executable}`)
    const first = r.render(snapshot)
    void first.catch(() => {})
    await assert.rejects(r.render(snapshot), /busy/)
    const cold = await first
    opaque(cold)
    records.push({ label: 'cold', renderCallMs: cold.renderCallMs, coldStartMs: r.coldStartMs, startupMs: { ...r.startupMs } })
    const warm = await render('warm')
    assert.deepEqual(warm.png, cold.png)
    await writeFile(path.join(output, 'frozen.png'), cold.png)
    await writeFile(path.join(output, 'frozen.jpg'), cold.jpeg)
  })

  await t.test('mod leaf holes retain the touching stone surface in the real browser mesh', async () => {
    const leaves = structuredClone(snapshot)
    // Offset from the opaque centre of the oak-leaf sprite so its holes face the wall.
    leaves.camera = { eye: { x: 0.5, y: 0.25, z: 0.375 }, look: { x: 1, y: 0, z: 0 }, yaw: 270, pitch: 0 }
    leaves.blocks = { x: 0, y: 0, z: 0, sx: 3, sy: 1, sz: 1, palette: [{ id: 'minecraft:air' }, { id: 'BiomesOPlenty:leaves1' }, { id: 'minecraft:stone' }], runs: [1, 2, 2, 1], unloaded: 0 }
    const picture = await r.render(leaves)
    opaque(picture)
    assert.equal(picture.faces, 17)
    const { rgba } = decodePng(picture.png)
    let stonePixels = 0
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] > 20 && rgba[i] < 180 && Math.abs(rgba[i] - rgba[i + 1]) < 3 && Math.abs(rgba[i + 1] - rgba[i + 2]) < 3) stonePixels++
    }
    assert.ok(stonePixels > 100, 'stone is visible through leaf holes, rather than the blue background')
    await writeFile(path.join(output, 'leaf-wall.png'), picture.png)
  })

  await t.test('a frame whose mesh exceeds the supported range fails instead of returning a partial image', async () => {
    const oversized = structuredClone(snapshot)
    oversized.blocks = { x: 0, y: 0, z: 0, sx: 45, sy: 45, sz: 45, palette: [{ id: 'minecraft:air' }, { id: 'minecraft:leaves' }], runs: [1, 45 ** 3], unloaded: 0 }
    await assert.rejects(r.render(oversized), /Snapshot mesh truncated/)
    await assertReleased((await f.launches()).at(-1)!)
    await render('after mesh failure')
  })

  await t.test('cancelling an active warm frame retires Chrome, and a timed-out next startup is also retryable', async () => {
    const controller = new AbortController()
    const rendering = assert.rejects(r.render(snapshot, { signal: controller.signal }), { name: 'AbortError' })
    // perform() has already frozen the scene; its queued continuation sends the real CDP
    // frame request before this cancellation, rather than a pre-aborted shortcut.
    queueMicrotask(() => controller.abort())
    await rendering
    await assertReleased((await f.launches()).at(-1)!)
    const before = (await f.launches()).length
    const timed = assert.rejects(r.render(snapshot, { timeoutMs: 500 }), /timed out/)
    await Promise.all([timed, until(f.launches, rows => rows.length > before)])
    await assertReleased((await f.launches()).at(-1)!)
    await render('after cancellation and timeout')
  })

  await t.test('an idle Chrome crash releases the old profile and the next frozen render succeeds', async () => {
    const launch = (await f.launches()).at(-1)!
    process.kill(launch.chromePid!, 'SIGKILL')
    await assertReleased(launch)
    await render('after idle Chrome crash')
  })

  await t.test('close during a real warm frame rejects the frame and finishes within the shutdown budget', async () => {
    const rendering = assert.rejects(r.render(snapshot), /closed/)
    await Promise.resolve() // Let the real CDP frame request be sent before close().
    const started = performance.now()
    await r.close()
    await rendering
    const closeMs = performance.now() - started
    records.push({ label: 'close during render', closeMs })
    assert.ok(closeMs < 3000)
    await assertReleased((await f.launches()).at(-1)!)
  })

  await t.test('close during real Chrome startup never creates a late session or leaks its profile', async () => {
    const fresh = await fixture(t, `real:${executable}`, pack)
    const rendering = assert.rejects(fresh.renderer.render(snapshot), /closed/)
    const launches = await until(fresh.launches, rows => rows.some(r => !!r.chromePid))
    const launch = launches.find(r => r.chromePid)!
    const started = performance.now()
    await fresh.renderer.close()
    await rendering
    records.push({ label: 'close during startup', closeMs: performance.now() - started })
    assert.ok(performance.now() - started < 3000)
    await assertReleased(launch)
    await assert.rejects(fresh.renderer.render(snapshot), /closed/)
  })

  await writeFile(path.join(output, 'results.json'), JSON.stringify(records, null, 2))
  t.diagnostic(`Frozen PNG/JPEG and timing/diagnostics: ${output}`)
})
