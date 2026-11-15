// Project-owned Node entry; calculation and machine mathematics remain upstream.
import { z } from 'zod';
import { factoryProjectSchema } from './upstream/src/lib/model/schemas';
import type { FactoryProject } from './upstream/src/lib/model/types';
import { calculateThroughput } from './upstream/src/lib/solver/throughput';
import { solvePlan } from './upstream/src/lib/solver/plan/solve-plan';
import { initLpEngine, activeLpEngine, resetLpDiagnostics, getLpDiagnostics } from './upstream/src/lib/solver/lp-engine';

export { activeLpEngine, resetLpDiagnostics, getLpDiagnostics };
export async function initialize(wasmPath: string): Promise<void> {
  if (!await initLpEngine({ wasmUrl: wasmPath })) {
    throw new Error('Bundled HiGHS WASM could not be initialized. No simplex-only service is started.');
  }
}

const safeId = z.string().min(1).refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id), 'Reserved identifier');
function checkIds(groups: { id: string }[][]): void {
  const seen = new Set<string>();
  for (const group of groups) for (const { id } of group) {
    safeId.parse(id);
    if (seen.has(id)) {
      const error = new Error(`Duplicate planner identifier: ${id}`);
      error.name = 'ValidationError';
      throw error;
    }
    seen.add(id);
  }
}

export function calculateNative(raw: unknown): unknown {
  const project = factoryProjectSchema.parse(raw) as FactoryProject;
  checkIds([project.nodes, project.storages ?? []]);
  checkIds([project.recipes]);
  checkIds([project.edges]);
  return calculateThroughput(project);
}

// The raw comparison entry accepts the mod's SolveInputJson format. Float chances
// are rounded exactly as upstream __fixtures__/load.ts (Java float -> JS double).
const rates = z.record(z.string().regex(/^\d+$/), z.number());
const port = z.object({
  amount: z.number(), chance: z.number().min(0).max(1).transform(Math.fround),
  multiplier: z.number(), resource: z.number().int(), name: z.string(), free: z.boolean(),
});
const link = z.object({ node: safeId, port: z.number().int().nonnegative() });
const solveInputSchema = z.object({
  mode: z.literal('AUTO'),
  choice: z.array(z.object({ node: safeId, port: z.number().int().nonnegative(), input: z.boolean() })).nullable().optional(),
  machines: z.array(z.object({
    id: safeId, name: z.string(), durationTicks: z.number(), energyPerTick: z.number(), throughputFactor: z.number(),
    inputs: z.array(port), outputs: z.array(port), countFixed: z.boolean(), machineCount: z.number(),
    targetOutputRates: rates.default({}), targetInputRates: rates.default({}),
  })),
  edges: z.array(z.object({ id: safeId, source: safeId, sourceOutput: z.number().int().nonnegative(), target: safeId, targetInput: z.number().int().nonnegative() })),
  pools: z.array(z.object({ machines: z.array(safeId), capacity: z.number(), exact: z.boolean(), upTo: z.boolean().optional() })).default([]),
  drawers: z.array(z.object({
    id: safeId, label: z.string(), kind: z.enum(['SOURCE', 'PRODUCT', 'BYPRODUCT', 'TRASH', 'BUFFER']),
    rule: z.enum(['ANY', 'AT_LEAST', 'EXACTLY', 'AT_MOST']), rate: z.number(), links: z.array(link), takers: z.array(link).optional(),
  })).default([]),
  extentPins: z.record(safeId, z.number()).default({}),
  spares: z.record(z.string(), z.record(z.string(), z.number())).default({}),
});

export function solveNative(raw: unknown): unknown {
  const input = solveInputSchema.parse(raw);
  checkIds([input.machines, input.drawers]);
  checkIds([input.edges]);
  return solvePlan(input);
}
