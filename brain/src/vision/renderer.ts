import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { FirstPersonSnapshot } from '../bridge/protocol.ts'
import type { PackData } from '../packdata/index.ts'
import { ChromePipe, chromeExecutable } from './chrome-pipe.ts'
import { FRAME, snapshotScene } from './scene.ts'
import type { SceneDiagnostics } from './scene.ts'
export { FRAME, snapshotScene } from './scene.ts'
export type { SceneDiagnostics } from './scene.ts'

export interface SnapshotPicture {
  png: Buffer
  jpeg: Buffer
  renderMs: number
  phasesMs: { mesh: number; draw: number; encode: number }
  renderCallMs: number
  faces: number
  renderer: string
  substitutes: string[]
  diagnostics: SceneDiagnostics
}

export interface RendererOptions { executable?: string }
export interface RenderOptions { signal?: AbortSignal; timeoutMs?: number }

/** Measured cold startup is 11–26s; 45s leaves room for the body's 15s request timeout.
 * Operators may change the overall observation deadline; the upper bound is Node's timer range. */
export function viewTimeoutMs(raw: string | number | undefined = process.env.AIPLAYER_VIEW_TIMEOUT_MS): number {
  const value = raw === undefined ? 45_000 : typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('AIPLAYER_VIEW_TIMEOUT_MS/timeoutMs must be an integer from 1 to 2147483647 (Node timer range)')
  return value
}

interface Resources {
  server?: Server
  profile?: string
  chrome?: ChromePipe
  session?: string
  window?: string
  closing?: Promise<void>
}

function cancelled(reason?: unknown): Error {
  return new DOMException(`First-person render cancelled${reason instanceof Error ? `: ${reason.message}` : ''}`, 'AbortError')
}

/** Lazy, single-flight renderer of frozen observations. No game connection or startup side effects. */
export class FirstPersonRenderer {
  private packdata: PackData
  private options: RendererOptions
  private resources?: Resources
  private retiring?: Promise<void>
  private active?: { controller: AbortController; done: Promise<SnapshotPicture> }
  private closed = false
  private closing?: Promise<void>
  coldStartMs = 0
  startupMs: Record<string, number> = {}

  constructor(packdata: PackData, options: RendererOptions = {}) {
    this.packdata = packdata
    this.options = { ...options }
  }

  private retire(resources: Resources): Promise<void> {
    if (resources.closing) return resources.closing
    if (this.resources === resources) this.resources = undefined
    resources.closing = (async () => {
      const httpClosed = new Promise<void>(resolve => {
        if (!resources.server) { resolve(); return }
        resources.server.close(() => resolve())
        resources.server.closeAllConnections()
      })
      try { await Promise.all([resources.chrome?.close(), httpClosed]) }
      finally { if (resources.profile) await rm(resources.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) }
    })()
    this.retiring = resources.closing
    // Idle process failures have no caller yet. Preserve the rejection for render()/close().
    void this.retiring.catch(() => {})
    return resources.closing
  }

  private failed(resources: Resources, error: Error): void {
    if (this.resources !== resources) return
    if (this.active) this.active.controller.abort(error)
    else void this.retire(resources)
  }

  private async start(resources: Resources, signal: AbortSignal): Promise<void> {
    const start = performance.now()
    const executable = await chromeExecutable(this.options.executable ?? process.env.AIPLAYER_VIEW_CHROME)
    signal.throwIfAborted()
    const read = async (file: URL | string) => readFile(file, { signal })
    let atlas: Buffer
    try { atlas = await read(this.packdata.textures!.file) }
    catch (cause) {
      signal.throwIfAborted()
      throw new Error('First-person renderer unavailable: pack texture atlas cannot be read', { cause })
    }
    const assets = new Map([
      ['/', { type: 'text/html', data: Buffer.from('<!doctype html><canvas></canvas><script>window.ready=import("/frame-page.js").then(m=>window.renderSnapshot=m.render)</script>') }],
      ['/viewer3d.js', { type: 'text/javascript', data: await read(new URL('../panel/public/viewer3d.js', import.meta.url)) }],
      ['/frame-page.js', { type: 'text/javascript', data: await read(new URL('./frame-page.js', import.meta.url)) }],
      ['/atlas.png', { type: 'image/png', data: atlas }],
    ])
    signal.throwIfAborted()
    resources.profile = await mkdtemp(path.join(tmpdir(), 'aiplayer-vision-chrome-'))
    signal.throwIfAborted()
    const server = resources.server = createServer((req, res) => {
      const asset = (req.method === 'GET' || req.method === 'HEAD') ? assets.get(req.url ?? '') : undefined
      res.writeHead(asset ? 200 : 404, {
        'Content-Type': asset?.type ?? 'text/plain', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; img-src 'self'",
      })
      res.end(req.method === 'HEAD' ? undefined : asset?.data ?? 'not found')
    })
    server.keepAliveTimeout = 100
    server.requestTimeout = 1000
    server.on('error', error => this.failed(resources, error))
    await new Promise<void>((resolve, reject) => {
      const abort = () => finish(signal.reason)
      const error = (cause: Error) => finish(cause)
      const finish = (cause?: Error) => {
        signal.removeEventListener('abort', abort)
        server.removeListener('error', error)
        cause ? reject(cause) : resolve()
      }
      signal.addEventListener('abort', abort, { once: true })
      server.once('error', error)
      server.listen(0, '127.0.0.1', () => finish())
    })
    signal.throwIfAborted()
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No renderer loopback address')
    this.startupMs = { assets: performance.now() - start }
    const chrome = resources.chrome = new ChromePipe(executable, resources.profile, error => this.failed(resources, error))
    const { targetId } = await chrome.call('Target.createTarget', { url: 'about:blank' }, undefined, signal)
    this.startupMs.chromeTarget = performance.now() - start
    const { sessionId } = await chrome.call('Target.attachToTarget', { targetId, flatten: true }, undefined, signal)
    resources.session = sessionId
    const navigation = await chrome.call('Page.navigate', { url: `http://127.0.0.1:${address.port}/` }, sessionId, signal)
    if (navigation.errorText) throw new Error(`Renderer page unavailable: ${navigation.errorText}`)
    while (true) {
      const result = await chrome.call('Runtime.evaluate', { expression: 'window.ready ? window.ready.then(()=>true) : false', awaitPromise: true, returnByValue: true }, sessionId, signal)
      if (result.exceptionDetails) throw new Error(`Renderer page failed: ${JSON.stringify(result.exceptionDetails)}`)
      if (result.result?.value === true) break
      await delay(20, undefined, { signal })
    }
    const window = await chrome.call('Runtime.evaluate', { expression: 'window' }, sessionId, signal)
    if (!window.result?.objectId) throw new Error('Renderer page has no window')
    resources.window = window.result.objectId
    this.coldStartMs = performance.now() - start
    this.startupMs.atlasAndPageReady = this.coldStartMs
  }

  render(snapshot: FirstPersonSnapshot, options: RenderOptions = {}): Promise<SnapshotPicture> {
    if (options.signal?.aborted) return Promise.reject(cancelled(options.signal.reason))
    if (this.closed) return Promise.reject(new Error('First-person renderer is closed'))
    if (this.active) return Promise.reject(new Error('First-person renderer is busy; try again after the current picture'))
    let timeoutMs: number
    try { timeoutMs = viewTimeoutMs(options.timeoutMs) } catch (error) { return Promise.reject(error) }
    const controller = new AbortController()
    const abort = () => controller.abort(cancelled(options.signal?.reason))
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error(`First-person render timed out after ${timeoutMs}ms`)), timeoutMs)
    // Install active before any async startup work. close() can then always cancel and join it.
    const active = { controller, done: undefined as unknown as Promise<SnapshotPicture> }
    this.active = active
    active.done = this.perform(snapshot, controller.signal).finally(() => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (this.active === active) this.active = undefined
    })
    return active.done
  }

  private async perform(snapshot: FirstPersonSnapshot, signal: AbortSignal): Promise<SnapshotPicture> {
    const start = performance.now()
    try {
      signal.throwIfAborted()
      const { scene, camera, substitutes, diagnostics } = snapshotScene(snapshot, this.packdata)
      await this.retiring
      signal.throwIfAborted()
      if (!this.resources) {
        const resources = this.resources = {}
        await this.start(resources, signal)
      }
      signal.throwIfAborted()
      const resources = this.resources!
      // Pass bounded JSON values as CDP arguments, never as source code interpolation.
      const result = await resources.chrome!.call('Runtime.callFunctionOn', {
        objectId: resources.window,
        functionDeclaration: 'function(payload) { return this.renderSnapshot(payload) }',
        arguments: [{ value: { scene, camera, ...FRAME } }], awaitPromise: true, returnByValue: true,
      }, resources.session, signal)
      signal.throwIfAborted()
      if (result.exceptionDetails) throw new Error(`Renderer frame failed: ${JSON.stringify(result.exceptionDetails)}`)
      const value = result.result?.value
      if (typeof value?.png !== 'string' || !value.png || typeof value.jpeg !== 'string' || !value.jpeg) throw new Error('Renderer returned no picture')
      return { png: Buffer.from(value.png, 'base64'), jpeg: Buffer.from(value.jpeg, 'base64'), renderMs: value.renderMs, phasesMs: value.phasesMs, renderCallMs: performance.now() - start, faces: value.faces, renderer: value.renderer, substitutes, diagnostics }
    } catch (error) {
      if (this.resources) await this.retire(this.resources)
      throw signal.aborted ? signal.reason : error
    }
  }

  /** Terminal and idempotent. Cancels startup/render before joining cleanup (no CDP shutdown wait). */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.active?.controller.abort(new Error('First-person renderer closed'))
    this.closing = (async () => {
      await this.active?.done.catch(() => {})
      if (this.resources) await this.retire(this.resources)
      await this.retiring
    })()
    return this.closing
  }
}
