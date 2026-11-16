import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import path from 'node:path'
import type { Writable, Readable } from 'node:stream'

export async function chromeExecutable(configured?: string): Promise<string> {
  const names = configured ? [configured] : ['google-chrome', 'chromium', 'chromium-browser', '/opt/google/chrome/chrome']
  for (const name of names) {
    const candidates = name.includes('/') ? [path.resolve(name)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))
    for (const file of candidates) {
      try { await access(file, constants.X_OK); return file } catch { /* try the next installed binary */ }
    }
  }
  throw new Error(`First-person renderer unavailable: Chrome executable not found${configured ? ` (${configured})` : '; set AIPLAYER_VIEW_CHROME'}`)
}

interface Pending {
  resolve(value: any): void
  reject(error: Error): void
  cleanup(): void
}

async function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try { await Promise.race([promise, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })]) }
  finally { clearTimeout(timer) }
}

/** Private process group, private profile, anonymous CDP pipe. Never attaches to a user's Chrome. */
export class ChromePipe {
  private process: ChildProcess
  private input: Readable
  private output: Writable
  private next = 0
  private pending = new Map<number, Pending>()
  private tail = ''
  private failure?: Error
  private closing?: Promise<void>
  private exited: Promise<void>
  private onFailure: (error: Error) => void

  constructor(executable: string, profile: string, onFailure: (error: Error) => void) {
    this.onFailure = onFailure
    this.process = spawn(executable, [
      '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--disable-extensions',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
    ], { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
    this.exited = new Promise(resolve => this.process.once('close', () => resolve()))
    this.input = this.process.stdio[4] as Readable
    this.output = this.process.stdio[3] as Writable
    this.process.stderr?.on('data', () => {})
    this.process.stderr?.on('error', error => this.fail(error))
    this.process.on('error', error => this.fail(new Error(`First-person renderer unavailable: Chrome spawn failed: ${error.message}`, { cause: error })))
    this.process.on('exit', (code, signal) => this.fail(new Error(`Renderer Chrome exited (${signal ?? code})`)))
    this.input.on('error', error => this.fail(error))
    this.input.on('end', () => this.fail(new Error('Renderer Chrome CDP pipe closed')))
    this.output.on('error', error => this.fail(error))
    this.input.setEncoding('utf8')
    this.input.on('data', (data: string) => this.receive(data))
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const p of this.pending.values()) { p.cleanup(); p.reject(error) }
    this.pending.clear()
    if (!this.closing) this.onFailure(error)
  }

  private receive(data: string): void {
    if (this.failure) return
    this.tail += data
    // A 512×288 result fits comfortably. Bound broken/malicious subprocess output too.
    if (this.tail.length > 8 * 1024 * 1024) { this.fail(new Error('Renderer Chrome CDP message too large')); return }
    let end: number
    while ((end = this.tail.indexOf('\0')) !== -1) {
      const text = this.tail.slice(0, end)
      this.tail = this.tail.slice(end + 1)
      if (!text) continue
      let message: any
      try {
        message = JSON.parse(text)
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('expected an object')
      } catch (cause) { this.fail(new Error('Renderer Chrome sent malformed CDP JSON', { cause })); return }
      const p = this.pending.get(message.id)
      if (!p) continue // CDP events and replies to cancelled requests.
      this.pending.delete(message.id)
      p.cleanup()
      if (message.error) p.reject(new Error(`Renderer CDP error: ${JSON.stringify(message.error)}`))
      else p.resolve(message.result)
    }
  }

  call(method: string, params: object = {}, sessionId?: string, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.failure) return Promise.reject(this.failure)
    if (this.pending.size >= 16) return Promise.reject(new Error('Renderer Chrome is busy (too many pending CDP requests)'))
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const abort = () => finish(signal!.reason)
      const timer = setTimeout(() => finish(new Error(`Renderer CDP timeout: ${method}`)), 45_000)
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      const finish = (error: Error) => {
        if (!this.pending.delete(id)) return
        cleanup()
        reject(error)
      }
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.output.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => { if (error) this.fail(error) })
      } catch (cause) { this.fail(new Error('Renderer Chrome CDP write failed', { cause })) }
    })
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    // Do not send Browser.close and wait for a CDP timeout during brain shutdown.
    this.closing = Promise.resolve().then(async () => {
      this.fail(new Error('Renderer Chrome closed'))
      const kill = (signal: NodeJS.Signals) => {
        if (!this.process.pid) return
        try {
          if (process.platform === 'win32') this.process.kill(signal)
          else process.kill(-this.process.pid, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      kill('SIGTERM')
      await waitAtMost(this.exited, 750)
      kill('SIGKILL') // Reap descendants even when the browser parent already exited.
      await waitAtMost(this.exited, 750)
      this.input.destroy()
      this.output.destroy()
      this.process.stderr?.destroy()
    })
    return this.closing
  }
}
