import { Worker } from 'node:worker_threads';

export const PLANNER_ENGINE_SOURCE = Object.freeze({
  name: 'gtnh-factory-flow',
  commit: 'e493e36a64d5a226e6110fab8a765ae08c3bf7c5',
  referenceModCommit: '69dd09fe21117d7b8558625dc9556723873942ca',
  highs: '1.15.2',
  zod: '4.4.3',
});

export type PlannerEngineErrorCode =
  | 'busy' | 'timeout' | 'aborted' | 'invalid' | 'closed' | 'unavailable' | 'error' | 'limit';

export class PlannerEngineError extends Error {
  readonly code: PlannerEngineErrorCode;
  run?: PlannerEngineRun;
  constructor(code: PlannerEngineErrorCode, message: string) {
    super(message);
    this.name = 'PlannerEngineError';
    this.code = code;
  }
}

export interface PlannerCalculateOptions {
  /** Total deadline, including queue wait and worker initialization. Default: 30 seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PlannerEngineOptions {
  timeoutMs?: number;
  /** Waiting requests, in addition to the one running request. Default: 2; maximum: 8. */
  maxQueued?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

export interface PlannerEngineDiagnostics {
  backend: 'highs' | 'simplex';
  highsCalls: number;
  simplexCalls: number;
  fallbackErrors: string[];
}

export interface PlannerEngineRun {
  id: number;
  source: typeof PLANNER_ENGINE_SOURCE;
  startedAt: string;
  completedAt: string;
  operation: 'calculate' | 'solve';
  outcome: 'ok' | PlannerEngineErrorCode;
  elapsedMs: number;
  diagnostics?: PlannerEngineDiagnostics;
}

export interface PlannerEngineResult {
  result: unknown;
  run: PlannerEngineRun;
}

export interface PlannerEngineInfo {
  source: typeof PLANNER_ENGINE_SOURCE;
  state: 'idle' | 'running' | 'closed';
  workerReady: boolean;
  workerStarts: number;
  queued: number;
  limits: Required<PlannerEngineOptions>;
  lastRun?: PlannerEngineRun;
}

interface Request {
  id: number;
  operation: 'calculate' | 'solve';
  json: string;
  start: number;
  startedAt: string;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort: () => void;
  resolve: (value: PlannerEngineResult) => void;
  reject: (error: PlannerEngineError) => void;
}

export interface PlannerWorkerResponse {
  id: number;
  ok: boolean;
  json?: string;
  error?: { code: PlannerEngineErrorCode; message: string };
  diagnostics?: PlannerEngineDiagnostics;
}

/**
 * Offline upstream calculator. The native English report is returned unchanged.
 * Inspect report.plan (including failure, forced flows and unmet drawers), not just
 * whether this Promise resolved. Backend/fallback information lives in info().lastRun.
 *
 * const engine = new PlannerEngine();
 * try { const nativeReport = await engine.calculate(factoryProject); }
 * finally { await engine.close(); }
 */
export class PlannerEngine {
  readonly #limits: Required<PlannerEngineOptions>;
  #worker?: Worker;
  #workerReady = false;
  #workerStarts = 0;
  #retiring?: Promise<void>;
  #closed = false;
  #sequence = 0;
  #active?: Request;
  #queue: Request[] = [];
  #lastRun?: PlannerEngineRun;

  constructor(options: PlannerEngineOptions = {}) {
    this.#limits = {
      timeoutMs: boundedInteger(options.timeoutMs ?? 30_000, 1, 120_000, 'timeoutMs'),
      maxQueued: boundedInteger(options.maxQueued ?? 2, 0, 8, 'maxQueued'),
      maxInputBytes: boundedInteger(options.maxInputBytes ?? 8 * 1024 * 1024, 1024, 32 * 1024 * 1024, 'maxInputBytes'),
      maxOutputBytes: boundedInteger(options.maxOutputBytes ?? 32 * 1024 * 1024, 1024, 64 * 1024 * 1024, 'maxOutputBytes'),
    };
  }

  async calculate(project: unknown, options: PlannerCalculateOptions = {}): Promise<unknown> {
    return (await this.calculateDetailed(project, options)).result;
  }

  /** Per-request receipt for saved analyses; unlike info().lastRun it cannot be overwritten by the next job. */
  calculateDetailed(project: unknown, options: PlannerCalculateOptions = {}): Promise<PlannerEngineResult> {
    return this.#submit('calculate', project, options);
  }

  /** Raw upstream SolveInput -> Answer. For corpus/independent numeric comparisons. */
  async solve(input: unknown, options: PlannerCalculateOptions = {}): Promise<unknown> {
    return (await this.solveDetailed(input, options)).result;
  }

  solveDetailed(input: unknown, options: PlannerCalculateOptions = {}): Promise<PlannerEngineResult> {
    return this.#submit('solve', input, options);
  }

  info(): PlannerEngineInfo {
    return {
      source: PLANNER_ENGINE_SOURCE,
      state: this.#closed ? 'closed' : this.#active ? 'running' : 'idle',
      workerReady: this.#workerReady,
      workerStarts: this.#workerStarts,
      queued: this.#queue.length,
      limits: { ...this.#limits },
      ...(this.#lastRun ? { lastRun: structuredClone(this.#lastRun) } : {}),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const request of [this.#active, ...this.#queue]) {
      if (request) this.#finish(request, new PlannerEngineError('closed', 'Planner engine is closed.'));
    }
    await this.#retire();
  }

  async #submit(operation: Request['operation'], value: unknown, options: PlannerCalculateOptions): Promise<PlannerEngineResult> {
    if (this.#closed) throw new PlannerEngineError('closed', 'Planner engine is closed.');
    if (options.signal?.aborted) throw new PlannerEngineError('aborted', 'Planner request was aborted.');
    if ((this.#active || this.#retiring) && this.#queue.length >= this.#limits.maxQueued) {
      throw new PlannerEngineError('busy', 'Planner request queue is full.');
    }
    const timeoutMs = boundedInteger(options.timeoutMs ?? this.#limits.timeoutMs, 1, 120_000, 'timeoutMs');
    const start = performance.now();
    const json = encodePlannerJson(value, this.#limits.maxInputBytes);
    return new Promise((resolve, reject) => {
      const request: Request = {
        id: ++this.#sequence, operation, json, start, startedAt: new Date().toISOString(), resolve, reject,
        signal: options.signal,
        abort: () => this.#interrupt(request, 'aborted', 'Planner request was aborted.'),
        timer: setTimeout(() => this.#interrupt(request, 'timeout', `Planner request exceeded ${timeoutMs} ms.`),
          Math.max(1, timeoutMs - (performance.now() - start))),
      };
      options.signal?.addEventListener('abort', request.abort, { once: true });
      this.#queue.push(request);
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#closed || this.#active || this.#retiring) return;
    const request = this.#queue.shift();
    if (!request) { this.#worker?.unref(); return; }
    this.#active = request;
    try {
      if (!this.#worker) {
        const worker = new Worker(new URL('./engine-worker.ts', import.meta.url), {
          // A native Node 24 TS worker must not inherit --input-type, test runners or host preloads.
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
        });
        this.#worker = worker;
        this.#workerStarts++;
        worker.on('message', (message: PlannerWorkerResponse) => {
          if (this.#worker !== worker || this.#active?.id !== message.id) return;
          this.#workerReady = message.error?.code !== 'unavailable';
          const active = this.#active;
          if (!message.ok) {
            const error = new PlannerEngineError(message.error?.code ?? 'error', message.error?.message ?? 'Planner worker failed.');
            if (error.code === 'unavailable') void this.#retire();
            this.#finish(active, error, undefined, message.diagnostics);
          } else {
            try {
              if (typeof message.json !== 'string' || Buffer.byteLength(message.json) > this.#limits.maxOutputBytes) {
                throw new PlannerEngineError('limit', 'Planner output exceeds its byte limit.');
              }
              this.#finish(active, undefined, JSON.parse(message.json) as unknown, message.diagnostics);
            } catch (error) {
              this.#finish(active, error instanceof PlannerEngineError ? error : new PlannerEngineError('error', 'Invalid planner worker response.'));
            }
          }
        });
        worker.on('error', (error) => this.#workerFailed(worker, error.message));
        worker.on('exit', (code) => this.#workerFailed(worker, `Planner worker exited (${code}).`));
      }
      this.#worker.ref();
      this.#worker.postMessage({ id: request.id, operation: request.operation, json: request.json, maxOutputBytes: this.#limits.maxOutputBytes });
    } catch (error) {
      void this.#retire();
      this.#finish(request, new PlannerEngineError('error', error instanceof Error ? error.message : String(error)));
    }
  }

  #workerFailed(worker: Worker, message: string): void {
    if (worker !== this.#worker) return;
    void this.#retire();
    if (this.#active) this.#finish(this.#active, new PlannerEngineError('error', message));
  }

  #interrupt(request: Request, code: 'timeout' | 'aborted', message: string): void {
    if (request !== this.#active && !this.#queue.includes(request)) return;
    if (request === this.#active) void this.#retire();
    this.#finish(request, new PlannerEngineError(code, message));
  }

  #finish(request: Request, error?: PlannerEngineError, value?: unknown, diagnostics?: PlannerEngineDiagnostics): void {
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
    if (this.#active === request) this.#active = undefined;
    else this.#queue = this.#queue.filter((queued) => queued !== request);
    const run: PlannerEngineRun = {
      id: request.id, source: PLANNER_ENGINE_SOURCE, startedAt: request.startedAt, completedAt: new Date().toISOString(),
      operation: request.operation, outcome: error?.code ?? 'ok', elapsedMs: performance.now() - request.start,
      ...(diagnostics ? { diagnostics } : {}),
    };
    if (diagnostics) { Object.freeze(diagnostics.fallbackErrors); Object.freeze(diagnostics); }
    Object.freeze(run);
    this.#lastRun = run;
    if (error) { error.run = run; request.reject(error); } else request.resolve({ result: value, run });
    queueMicrotask(() => this.#pump());
  }

  #retire(): Promise<void> {
    if (this.#retiring) return this.#retiring;
    const worker = this.#worker;
    this.#worker = undefined;
    this.#workerReady = false;
    if (!worker) return Promise.resolve();
    this.#retiring = worker.terminate().then(() => {}, () => {}).finally(() => {
      this.#retiring = undefined;
      this.#pump();
    });
    return this.#retiring;
  }
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PlannerEngineError('invalid', `${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** Bounded plain-JSON snapshot; never call caller-owned getters or toJSON hooks. */
export function encodePlannerJson(value: unknown, maxBytes: number): string {
  let visited = 0;
  let estimatedBytes = 0;
  const ancestors = new Set<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (++visited > 250_000 || depth > 64) throw new PlannerEngineError('limit', 'Planner JSON exceeds its structure limit.');
    if (item === null || typeof item === 'boolean') { estimatedBytes += 5; return item; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new PlannerEngineError('invalid', 'Planner JSON numbers must be finite.');
      estimatedBytes += 24;
      return item;
    }
    if (typeof item === 'string') {
      estimatedBytes += Buffer.byteLength(item);
      if (estimatedBytes > maxBytes) throw new PlannerEngineError('limit', 'Planner input exceeds its byte limit.');
      return item;
    }
    if (typeof item !== 'object') throw new PlannerEngineError('invalid', 'Planner input must be plain JSON.');
    if (ancestors.has(item)) throw new PlannerEngineError('invalid', 'Planner JSON contains a cycle.');
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new PlannerEngineError('invalid', 'Planner input must contain only plain JSON objects.');
    }
    ancestors.add(item);
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new PlannerEngineError('invalid', 'Unsafe planner JSON key.');
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in descriptor)) throw new PlannerEngineError('invalid', 'Planner JSON cannot contain accessors.');
      // Match ordinary JSON serialization for optional object properties.
      if (descriptor.value === undefined && !array) continue;
      estimatedBytes += Buffer.byteLength(key) + 4;
      if (estimatedBytes > maxBytes) throw new PlannerEngineError('limit', 'Planner input exceeds its byte limit.');
      (result as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return result;
  };
  const json = JSON.stringify(copy(value, 0));
  if (Buffer.byteLength(json) > maxBytes) throw new PlannerEngineError('limit', 'Planner input exceeds its byte limit.');
  return json;
}
