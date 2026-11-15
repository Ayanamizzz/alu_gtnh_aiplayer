import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parentPort } from 'node:worker_threads';
import type { PlannerEngineDiagnostics, PlannerEngineErrorCode, PlannerWorkerResponse } from './engine.ts';

interface Runtime {
  initialize(wasmPath: string): Promise<void>;
  calculateNative(project: unknown): unknown;
  solveNative(input: unknown): unknown;
  resetLpDiagnostics(): void;
  getLpDiagnostics(): PlannerEngineDiagnostics;
}
interface WorkerRequest {
  id: number;
  operation: 'calculate' | 'solve';
  json: string;
  maxOutputBytes: number;
}

const port = parentPort;
if (!port) throw new Error('Planner calculator must run in a worker thread.');
let runtime: Runtime | undefined;
let initialization: Promise<Runtime> | undefined;
let assetHashes: { runtimeSha256: string; wasmSha256: string } | undefined;
function diagnostics(): PlannerEngineDiagnostics {
  return { ...runtime!.getLpDiagnostics(), ...assetHashes };
}
function load(): Promise<Runtime> {
  initialization ??= (async () => {
    const runtimeUrl = new URL('../../vendor/gtnh-planner/dist/runtime.cjs', import.meta.url);
    const wasmUrl = new URL('../../vendor/gtnh-planner/dist/highs.wasm', import.meta.url);
    const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
    assetHashes = { runtimeSha256: sha256(await readFile(runtimeUrl)), wasmSha256: sha256(await readFile(wasmUrl)) };
    const bundled = createRequire(import.meta.url)(fileURLToPath(runtimeUrl)) as Runtime;
    await bundled.initialize(fileURLToPath(wasmUrl));
    runtime = bundled;
    return bundled;
  })();
  return initialization;
}

port.on('message', async (request: WorkerRequest) => {
  let response: PlannerWorkerResponse;
  try {
    const engine = await load();
    engine.resetLpDiagnostics();
    const input: unknown = JSON.parse(request.json);
    const result = request.operation === 'calculate' ? engine.calculateNative(input) : engine.solveNative(input);
    // JSON.stringify must not silently turn a numerical failure into null.
    const json = JSON.stringify(result, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Calculator produced a non-finite result.');
      return value;
    });
    if (typeof json !== 'string') throw new Error('Calculator did not return a JSON result.');
    if (Buffer.byteLength(json) > request.maxOutputBytes) {
      response = { id: request.id, ok: false, error: { code: 'limit', message: 'Planner output exceeds its byte limit.' } };
    } else {
      response = { id: request.id, ok: true, json };
    }
    response.diagnostics = diagnostics();
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const code: PlannerEngineErrorCode = !runtime ? 'unavailable' : name === 'PlannerLimitError' ? 'limit' : name === 'ZodError' || name === 'ValidationError' ? 'invalid' : 'error';
    response = {
      id: request.id, ok: false,
      error: { code, message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) },
      ...(runtime ? { diagnostics: diagnostics() } : {}),
    };
  }
  port.postMessage(response);
});
