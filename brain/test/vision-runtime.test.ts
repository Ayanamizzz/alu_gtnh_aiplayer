import assert from 'node:assert/strict'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { FirstPersonRenderer } from '../src/vision/renderer.ts'
import { ChromePipe } from '../src/vision/chrome-pipe.ts'
import { snapshotScene } from '../src/vision/scene.ts'
import { assertReleased, fixture, observation, until } from './fixture-vision.ts'

// Tests here require no Chrome installation, model credentials, game connection or packdata.
test('a cancelled request never starts Chrome, and concurrent pictures get an immediate busy result', async t => {
  const f = await fixture(t)
  await assert.rejects(f.renderer.render(observation, { signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.deepEqual(await f.launches(), [])
  const controller = new AbortController()
  const first = assert.rejects(f.renderer.render(observation, { signal: controller.signal }), { name: 'AbortError' })
  const [launch] = await until(f.launches, rows => rows.length > 0)
  await assert.rejects(f.renderer.render(observation), /busy/)
  controller.abort()
  await first
  await assertReleased(launch)
})

test('cancelling page startup closes its HTTP assets, Chrome and private profile', async t => {
  const f = await fixture(t, 'protocol')
  const controller = new AbortController()
  const rendering = assert.rejects(f.renderer.render(observation, { signal: controller.signal }), { name: 'AbortError' })
  const rows = await until(f.launches, rows => rows.some(r => !!r.url))
  const launch = rows.find(r => r.url)!
  const response = await fetch(launch.url! + 'atlas.png')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type')!, /image\/png/)
  await response.arrayBuffer()
  const missing = await fetch(launch.url! + 'etc/passwd')
  assert.equal(missing.status, 404)
  await missing.text()
  controller.abort()
  await rendering
  await assertReleased(launch)
})

test('a startup timeout reaps even a subprocess that ignores graceful termination and allows a fresh attempt', async t => {
  const f = await fixture(t, 'stubborn')
  const rendering = assert.rejects(f.renderer.render(observation, { timeoutMs: 300 }), /timed out/)
  const [launch] = await until(f.launches, rows => rows.length > 0)
  await rendering
  await assertReleased(launch)
  await f.mode('exit')
  await assert.rejects(f.renderer.render(observation), /Chrome (exited|CDP pipe closed)/)
  const rows = await f.launches()
  assert.equal(rows.length, 2)
  assert.notEqual(rows[1].profile, rows[0].profile)
  await assertReleased(rows[1])
})

test('a failed spawn and malformed CDP data reject promptly, then a later request can launch again', async t => {
  const f = await fixture(t, 'malformed')
  const wrapper = await readFile(f.executable)
  await writeFile(f.executable, '#!/missing/interpreter\n')
  await chmod(f.executable, 0o700)
  await assert.rejects(f.renderer.render(observation), /unavailable: Chrome spawn failed/)
  await writeFile(f.executable, wrapper)
  await assert.rejects(f.renderer.render(observation), /malformed CDP JSON/)
  const [launch] = await f.launches()
  await assertReleased(launch)
  await f.mode('exit')
  await assert.rejects(f.renderer.render(observation), /Chrome (exited|CDP pipe closed)/)
  assert.equal((await f.launches()).length, 2)
})

test('Chrome exiting during startup rejects its outstanding request and releases the HTTP endpoint', async t => {
  const f = await fixture(t, 'protocol')
  const rendering = assert.rejects(f.renderer.render(observation), /Chrome (exited|CDP pipe closed)/)
  const rows = await until(f.launches, rows => rows.some(r => !!r.url))
  const launch = rows.find(r => r.url)!
  process.kill(launch.pid, 'SIGKILL')
  await rendering
  await assertReleased(launch)
})

test('closing while starting is terminal, idempotent, releases resources and fits the brain shutdown budget', async t => {
  const f = await fixture(t, 'stubborn')
  const rendering = assert.rejects(f.renderer.render(observation), /closed/)
  const [launch] = await until(f.launches, rows => rows.length > 0)
  const start = performance.now()
  const closing = f.renderer.close()
  assert.equal(f.renderer.close(), closing)
  await assert.rejects(f.renderer.render(observation), /closed/)
  await closing
  await rendering
  assert.ok(performance.now() - start < 3000, 'shutdown must not wait for the CDP request timeout')
  await assertReleased(launch)
})

test('closing immediately after a first request cannot leave a late-started Chrome behind', async t => {
  const f = await fixture(t)
  const rendering = assert.rejects(f.renderer.render(observation), /closed/)
  await f.renderer.close()
  await rendering
  assert.deepEqual(await f.launches(), [])
})

test('a missing browser or atlas is unavailable on use, not on construction', async t => {
  const f = await fixture(t)
  const noChrome = new FirstPersonRenderer(f.packdata, { executable: '/missing/browser' })
  const noAtlas = new FirstPersonRenderer({ dir: '/unused' })
  const badAtlas = new FirstPersonRenderer({ ...f.packdata, textures: { ...f.packdata.textures!, file: '/missing/atlas.png' } }, { executable: f.executable })
  try {
    await assert.rejects(noChrome.render(observation), /unavailable: Chrome executable not found/)
    await assert.rejects(noAtlas.render(observation), /unavailable: pack texture atlas is missing/)
    await assert.rejects(badAtlas.render(observation), /unavailable: pack texture atlas cannot be read/)
    assert.deepEqual(await f.launches(), [])
  } finally { await Promise.all([noChrome.close(), noAtlas.close(), badAtlas.close()]) }
})

test('invalid camera and incomplete snapshot cells fail before browser startup rather than making a misleading image', async t => {
  const f = await fixture(t)
  const variants: [typeof observation, RegExp][] = []
  const zero = structuredClone(observation); zero.camera.look = { x: 0, y: 0, z: 0 }; variants.push([zero, /nonzero/])
  const infinite = structuredClone(observation); infinite.camera.eye.x = Infinity; variants.push([infinite, /finite world coordinate/])
  const broken = structuredClone(observation); broken.blocks.runs = [0, 0]; variants.push([broken, /runs/])
  const unknownAir = structuredClone(observation); unknownAir.blocks.unloaded = 1; variants.push([unknownAir, /unloaded count/])
  const oversized = structuredClone(observation); oversized.blocks.sx = 65; variants.push([oversized, /1 to 64/])
  for (const [snapshot, error] of variants) await assert.rejects(f.renderer.render(snapshot), error)
  assert.deepEqual(await f.launches(), [])
})

test('scene diagnostics name missing materials and coarse GT, garage-door and guessed-glass appearances', async t => {
  const f = await fixture(t)
  const snapshot = structuredClone(observation)
  snapshot.blocks = {
    x: 0, y: 0, z: 0, sx: 4, sy: 1, sz: 1,
    palette: [{ id: 'minecraft:air' }, { id: 'gregtech:gt.blockmachines', meta: 3 }, { id: 'malisisdoors:garage_door', meta: 0 }, { id: 'TConstruct:GlassBlock', meta: 0 }, { id: '?' }],
    runs: [1, 1, 2, 1, 3, 1, 4, 1], unloaded: 1,
  }
  const { diagnostics, scene } = snapshotScene(snapshot, f.packdata)
  assert.equal(diagnostics.unloadedCells, 1)
  assert.equal(scene.kinds[4]?.alpha, 1)
  assert.deepEqual(scene.kinds[4]?.side, [255, 0, 255])
  assert.ok(diagnostics.missingTextures.some(d => d.kind === 'gregtech:gt.blockmachines/3'))
  assert.ok(diagnostics.approximations.some(d => d.kind === 'gregtech:gt.blockmachines/3' && d.shape === 'full' && d.reason.includes('GT full-cube')))
  assert.ok(diagnostics.approximations.some(d => d.kind === 'malisisdoors:garage_door' && d.shape === 'post'))
  assert.ok(diagnostics.approximations.some(d => d.kind === 'TConstruct:GlassBlock' && d.reason.includes('guessed')))
})

test('a closed CDP command pipe rejects its caller instead of leaving it hanging', async t => {
  const f = await fixture(t, 'closed-input')
  const chrome = new ChromePipe(f.executable, f.dir, () => {})
  try {
    await until(f.launches, rows => rows.some(r => r.closedInput))
    await assert.rejects(chrome.call('Browser.getVersion'), /EPIPE|write|closed/)
  } finally { await chrome.close() }
})

test('a broken subprocess cannot accumulate unbounded CDP calls, and closing rejects every waiting caller', async t => {
  const f = await fixture(t)
  const chrome = new ChromePipe(f.executable, f.dir, () => {})
  const replies = Array.from({ length: 16 }, () => assert.rejects(chrome.call('Browser.getVersion'), /closed/))
  await assert.rejects(chrome.call('Browser.getVersion'), /too many pending/)
  await chrome.close()
  await Promise.all(replies)
})
