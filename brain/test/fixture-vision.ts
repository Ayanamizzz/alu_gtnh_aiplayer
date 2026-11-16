import assert from 'node:assert/strict'
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import type { FirstPersonSnapshot } from '../src/bridge/protocol.ts'
import type { PackData } from '../src/packdata/index.ts'
import { encodePng, Raster } from '../src/render/index.ts'
import { FirstPersonRenderer } from '../src/vision/renderer.ts'

export const observation: FirstPersonSnapshot = {
  version: 1, bot: 'Offline', dim: 0, tick: 1, time: 1, capturedAt: 1,
  camera: { eye: { x: 0.5, y: 0.5, z: -1 }, look: { x: 0, y: 0, z: 1 }, yaw: 0, pitch: 0 },
  blocks: { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1, palette: [{ id: 'minecraft:air' }, { id: 'minecraft:stone' }], runs: [1, 1], unloaded: 0 },
}

export async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  while (true) {
    const result = await read()
    if (accept(result)) return result
    if (Date.now() > end) throw new Error('Timed out waiting for subprocess observation')
    await delay(10)
  }
}

export interface Launch { pid: number; profile: string; url?: string; chromePid?: number; closedInput?: boolean }
export async function fixture(t: TestContext, mode = 'hang', pack?: PackData) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vision-test-'))
  const executable = path.join(dir, 'chrome.mjs')
  const control = path.join(dir, 'control')
  const log = path.join(dir, 'launches.jsonl')
  const atlas = path.join(dir, 'atlas.png')
  await writeFile(log, '')
  await writeFile(control, mode)
  await writeFile(atlas, encodePng(new Raster(16, 16, [100, 100, 100])))
  // This fixture replaces only the external CDP subprocess. Responses stop before
  // frame rendering; it never implements scene/renderer business logic or returns an image.
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs'
import {spawn} from 'node:child_process'
const mode = fs.readFileSync(${JSON.stringify(control)}, 'utf8')
const profile = process.argv.find(a => a.startsWith('--user-data-dir=')).split('=')[1]
const log = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,profile,...value})+'\\n')
log({})
if (mode.startsWith('real:')) {
  const chrome = spawn(mode.slice(5), process.argv.slice(2), {stdio:['ignore','ignore','inherit',3,4]})
  log({chromePid:chrome.pid})
  chrome.on('error', error => {console.error(error);process.exit(1)})
  chrome.on('exit', code => process.exit(code ?? 1))
}
if (mode === 'exit') process.exit(33)
if (mode === 'malformed') fs.writeSync(4, '{not JSON}\\0')
if (mode === 'closed-input') { fs.closeSync(3); log({closedInput:true}) }
if (mode === 'stubborn') process.on('SIGTERM', () => {})
if (mode === 'protocol') {
  let tail = ''
  const input = fs.createReadStream(null, {fd:3})
  input.on('data', data => {
    tail += data.toString()
    let end
    while ((end = tail.indexOf('\\0')) !== -1) {
      const message = JSON.parse(tail.slice(0,end)); tail = tail.slice(end+1)
      let result
      if (message.method === 'Target.createTarget') result = {targetId:'fixed-target'}
      if (message.method === 'Target.attachToTarget') result = {sessionId:'fixed-session'}
      if (message.method === 'Page.navigate') { log({url:message.params.url}); result = {frameId:'fixed-frame'} }
      if (result) fs.writeSync(4, JSON.stringify({id:message.id,result})+'\\0')
    }
  })
}
setInterval(() => {}, 1000)
`)
  await chmod(executable, 0o700)
  const packdata = pack ?? { dir, textures: { file: atlas, tile: 16, columns: 1, rows: 1, tiles: new Map([['stone', 0]]), version: 'test' } }
  const renderer = new FirstPersonRenderer(packdata, { executable })
  t.after(async () => { await renderer.close(); await rm(dir, { recursive: true, force: true }) })
  const launches = async (): Promise<Launch[]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { dir, executable, packdata, renderer, launches, mode: (value: string) => writeFile(control, value) }
}

export async function assertReleased(launch: Launch): Promise<void> {
  await until(async () => {
    try { await access(launch.profile); return false } catch { return true }
  }, Boolean)
  assert.throws(() => process.kill(launch.pid, 0), { code: 'ESRCH' })
  if (launch.url) await assert.rejects(fetch(launch.url, { signal: AbortSignal.timeout(1000) }))
}
