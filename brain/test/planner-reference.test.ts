import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { PlannerEngine } from '../src/planner/engine.ts'
import { PlannerWorkspace } from '../src/planner/workspace.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/index.ts'
import { tmpDir } from './helpers.ts'

it('helpers can discover and page the full original English contracts, not only an example graph', async (t) => {
  const tmp = tmpDir(), engine = new PlannerEngine()
  const directory = path.join(tmp.dir, 'analyses')
  const planner = new PlannerWorkspace({ directory, engine })
  t.after(async () => { await planner.close(); tmp.cleanup() })
  const ctx = { helper: 'h1', planner } as ToolContext
  const call = (input: unknown) => runTool(ALL_TOOLS, ctx, 'production_plan', input)
  const described = await call({ action: 'describe' })
  assert.match(described.content, /action:"reference"/)
  const found = await call({ action: 'reference', reference: 'project', query: 'export interface FactoryProject' })
  assert.equal(found.isError, undefined, found.content)
  const data = found.data as ReturnType<PlannerWorkspace['reference']>
  assert.ok(data.items.length > 0)
  assert.match(data.items[0]!.text, /export interface FactoryProject/)
  const around = await call({ action: 'reference', reference: 'project', offset: data.items[0]!.line - 1, limit: 80 })
  assert.match(around.content, /recipes:/)
  assert.match(around.content, /nodes:/)
  const fuel = await call({ action: 'reference', query: 'fuelProfiles' })
  assert.match(fuel.content, /fuelProfiles/)
  const tail = await call({ action: 'reference', offset: data.totalLines - 1, limit: 200 })
  const page = tail.data as ReturnType<PlannerWorkspace['reference']>
  assert.equal(page.items.at(-1)?.line, data.totalLines)
  assert.equal(page.more, false)
  const solver = await call({ action: 'reference', reference: 'solver', query: 'SolveInput' })
  assert.ok((solver.data as ReturnType<PlannerWorkspace['reference']>).total > 0)
  const invalid = await call({ action: 'reference', reference: '../../config.json' })
  assert.equal(invalid.isError, true)
  assert.equal(engine.info().workerStarts, 0)
  assert.equal(fs.existsSync(directory), false, 'reading contracts must not create an analysis or a world task')
})
