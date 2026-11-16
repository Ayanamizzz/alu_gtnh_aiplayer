// Opt-in probe only: not registered in the regular model tool catalog and never starts a Minecraft client.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Duplex, Readable } from 'node:stream'
import type { FirstPersonSnapshot } from '../bridge/protocol.ts'
import type { PackData } from '../packdata/index.ts'
import { gridFromBlocks, sceneOf } from '../render/index.ts'
import { looksFor } from '../tools/pictures.ts'
import { int, obj } from '../tools/schema.ts'
import type { Tool } from '../tools/types.ts'

/** CDP over a private anonymous pipe; no existing browser/profile/debugging port is used. */
class ChromePipe {
  private next = 0
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout }>()
  private tail = ''
  private process: ChildProcess
  constructor(profile: string) {
    this.process = spawn('/usr/bin/google-chrome', [
      '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--disable-extensions',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
    this.process.stderr?.on('data', () => {})
    const fail = (error: Error) => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
      this.pending.clear()
    }
    this.process.on('error', fail)
    this.process.on('exit', () => fail(new Error('Probe Chrome exited')))
    const input = this.process.stdio[4] as Readable
    input.setEncoding('utf8')
    input.on('data', (data: string) => {
      this.tail += data
      let end: number
      while ((end = this.tail.indexOf('\0')) !== -1) {
        const text = this.tail.slice(0, end)
        this.tail = this.tail.slice(end + 1)
        if (!text) continue
        const message = JSON.parse(text)
        const p = this.pending.get(message.id)
        if (!p) continue
        this.pending.delete(message.id)
        clearTimeout(p.timer)
        if (message.error) p.reject(new Error(JSON.stringify(message.error)))
        else p.resolve(message.result)
      }
    })
  }
  call(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      ;(this.process.stdio[3] as Duplex).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
    })
  }
  async close(): Promise<void> {
    if (this.process.exitCode !== null) return
    const exited = once(this.process, 'exit')
    await this.call('Browser.close').catch(() => {})
    const timer = setTimeout(() => this.process.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
  }
}

export const FRAME = { width: 512, height: 288, fov: 70 } as const

export function snapshotScene(snapshot: FirstPersonSnapshot, packdata: PackData) {
  if (snapshot.version !== 1) throw new Error('Unsupported snapshot version')
  if (!packdata.textures) throw new Error('Probe requires the existing pack texture atlas')
  const scene = sceneOf(gridFromBlocks(snapshot.blocks), looksFor(packdata), { textures: packdata.textures, atlasUrl: '/atlas.png' })
  const substitutes: string[] = []
  for (const k of scene.kinds) {
    if (!k) continue
    if (/^minecraft:leaves2?(\/|$)/.test(k.key)) k.cutout = true
    // Clear glass remains clear between its texture strokes (instead of the orbit viewer's coloured fill).
    if (/^minecraft:glass$/.test(k.key)) k.alpha = 0.04
    if (k.tex === undefined) {
      substitutes.push(k.key)
      k.side = [255, 0, 255]
      k.top = [255, 0, 255]
    }
  }
  return { scene, substitutes }
}

export interface SnapshotPicture {
  png: Buffer
  jpeg: Buffer
  renderMs: number
  phasesMs: { mesh: number; draw: number; encode: number }
  renderCallMs: number
  faces: number
  renderer: string
  substitutes: string[]
}

/** One private Chrome kept warm only for the lifetime of this disposable renderer. Call close() in finally. */
export class FirstPersonRenderer {
  private packdata: PackData
  private server?: Server
  private chrome?: ChromePipe
  private profile?: string
  private session?: string
  private starting?: Promise<void>
  private busy = false
  coldStartMs = 0
  startupMs: Record<string, number> = {}
  constructor(packdata: PackData) { this.packdata = packdata }

  private async start(): Promise<void> {
    const start = performance.now()
    const assets = new Map([
      ['/', { type: 'text/html', data: Buffer.from('<!doctype html><canvas></canvas><script>window.ready=import("/first-person-page.js").then(m=>window.renderSnapshot=m.render)</script>') }],
      ['/viewer3d.js', { type: 'text/javascript', data: await readFile(new URL('../panel/public/viewer3d.js', import.meta.url)) }],
      ['/first-person-page.js', { type: 'text/javascript', data: await readFile(new URL('./first-person-page.js', import.meta.url)) }],
      ['/atlas.png', { type: 'image/png', data: await readFile(this.packdata.textures!.file) }],
    ])
    this.server = createServer((req, res) => {
      const asset = assets.get(req.url ?? '')
      res.writeHead(asset ? 200 : 404, { 'Content-Type': asset?.type ?? 'text/plain' })
      res.end(asset?.data ?? 'not found')
    })
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('No renderer address')
    this.profile = await mkdtemp(path.join(tmpdir(), 'aiplayer-vision-chrome-'))
    this.startupMs.assets = performance.now() - start
    this.chrome = new ChromePipe(this.profile)
    const { targetId } = await this.chrome.call('Target.createTarget', { url: 'about:blank' })
    this.startupMs.chromeTarget = performance.now() - start
    this.session = (await this.chrome.call('Target.attachToTarget', { targetId, flatten: true })).sessionId
    await this.chrome.call('Page.navigate', { url: `http://127.0.0.1:${address.port}/` }, this.session)
    // Navigation is asynchronous. Poll the actual module+atlas promise, not a fixed sleep / presumed frame.
    const deadline = Date.now() + 30000
    while (true) {
      const result = await this.chrome.call('Runtime.evaluate', { expression: 'window.ready ? window.ready.then(()=>true) : false', awaitPromise: true, returnByValue: true }, this.session)
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      if (result.result.value === true) break
      if (Date.now() > deadline) throw new Error('Renderer module did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    this.coldStartMs = performance.now() - start
    this.startupMs.atlasAndPageReady = this.coldStartMs
  }

  async render(snapshot: FirstPersonSnapshot): Promise<SnapshotPicture> {
    if (this.busy) throw new Error('Experimental renderer supports one picture at a time')
    this.busy = true
    const start = performance.now()
    try {
      const { scene, substitutes } = snapshotScene(snapshot, this.packdata)
      this.starting ??= this.start()
      await this.starting
      const payload = JSON.stringify({ scene, camera: snapshot.camera, ...FRAME })
      const result = await this.chrome!.call('Runtime.evaluate', {
        expression: `window.renderSnapshot(${payload})`, awaitPromise: true, returnByValue: true,
      }, this.session)
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      const value = result.result.value
      if (typeof value?.png !== 'string' || typeof value?.jpeg !== 'string') throw new Error('Renderer returned no picture')
      return { png: Buffer.from(value.png, 'base64'), jpeg: Buffer.from(value.jpeg, 'base64'), renderMs: value.renderMs, phasesMs: value.phasesMs, renderCallMs: performance.now() - start, faces: value.faces, renderer: value.renderer, substitutes }
    } finally { this.busy = false }
  }

  async close(): Promise<void> {
    try { await this.chrome?.close() } finally {
      if (this.server) { this.server.closeAllConnections(); await new Promise<void>((resolve) => this.server!.close(() => resolve())) }
      if (this.profile) await rm(this.profile, { recursive: true, force: true })
    }
  }
}

/** Supply this opt-in tool in runTool([firstPersonTool(renderer)], ctx, ...). No model or owner session needed. */
export function firstPersonTool(renderer: Pick<FirstPersonRenderer, 'render'>): Tool {
  return {
    name: 'look_first_person_probe',
    picture: true,
    rawData: true,
    description: 'Look from your current real eyes and direction. Experimental textured reconstruction, not a Minecraft client screenshot; blocks only, no entities or dynamic machine details.',
    inputSchema: obj({ radius: int('Nearby snapshot radius in blocks (default 12).', { min: 2, max: 24 }) }),
    async run(ctx, input: { radius?: number }) {
      const start = performance.now()
      const snapshot = await ctx.bridge.botSnapshot(ctx.botName, input.radius ?? 12)
      const captureMs = performance.now() - start
      const picture = await renderer.render(snapshot)
      const { png, jpeg, ...renderInfo } = picture
      const data = { snapshot, ...FRAME, captureMs, ...renderInfo, totalMs: performance.now() - start, pngBytes: png.length, jpegBytes: jpeg.length }
      return {
        content: `Current first-person block reconstruction, ${FRAME.width}×${FRAME.height}, vertical FOV ${FRAME.fov}°, dimension ${snapshot.dim}, tick ${snapshot.tick}. Eye (${Object.values(snapshot.camera.eye).map(n => n.toFixed(2)).join(', ')}), yaw ${snapshot.camera.yaw.toFixed(1)}°, pitch ${snapshot.camera.pitch.toFixed(1)}°. Unloaded cells: ${snapshot.blocks.unloaded ?? 0}; missing textures shown magenta: ${picture.substitutes.join(', ') || 'none'}. No entities, dynamic tile entities, lighting simulation or scenery beyond the captured box. Non-full blocks (stairs, doors, panes, etc.) use approximate shapes.`,
        images: [{ label: 'current view from the bot’s eyes (block reconstruction)', mediaType: 'image/jpeg', data: jpeg }],
        data,
      }
    },
  }
}
