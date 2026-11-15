// Real Lines/Helpers, sandbox, tool dispatcher, immutable store and native HiGHS.
// Only the model and game boundary are scripted; this does not claim autonomous LLM acceptance.
import assert from 'node:assert/strict'
import path from 'node:path'
import { it } from 'node:test'
import { DesignWorkspace } from '../src/design/index.ts'
import { PlannerEngine } from '../src/planner/engine.ts'
import { NATIVE_PROJECT_EXAMPLE } from '../src/planner/model.ts'
import { PlannerWorkspace } from '../src/planner/workspace.ts'
import { lineCalls, makeAgent, reply, told } from './agent-harness.ts'
import { tmpDir, waitFor } from './helpers.ts'

const PROGRAM = `
const d = await tool('production_plan', {action:'describe'});
if (!d.ok) throw new Error(d.text);
const project = d.data.exampleProject;
project.name = 'Native plan constructed inside the brain sandbox';
const r = await tool('production_plan', {action:'solve', project});
if (!r.ok) throw new Error(r.text);
const saved = await tool('production_plan', {action:'read', id:r.data.id, section:'energy'});
if (!saved.ok) throw new Error(saved.text);
return { id:r.data.id, averageEuT:saved.data.summary.averageEuT,
  buildPeakEuT:saved.data.summary.buildPeakEuT, staticAnalysis:saved.data.summary.staticAnalysis };
`

it('both brain lines and an actual helper can construct and solve native plans without body actions', async (t) => {
  const tmp = tmpDir()
  const engine = new PlannerEngine()
  const planner = new PlannerWorkspace({ directory: path.join(tmp.dir, 'production-plans'), engine })
  const design = new DesignWorkspace({ dataDir: tmp.dir })
  const h = makeAgent({ dir: tmp.dir, planner, design, helper: true })
  t.after(async () => {
    await Promise.all([h.agent.stop(), planner.close()])
    tmp.cleanup()
  })
  for (const line of ['talk', 'work'] as const) {
    const result = await lineCalls(h, line, 'run_program', { code: PROGRAM })
    assert.equal(result.isError, false, result.content)
    assert.match(result.content, /"averageEuT":2/)
    assert.match(result.content, /"buildPeakEuT":2/)
    assert.match(result.content, /"staticAnalysis":true/)
  }
  h.helper!.enqueue(reply('', [{ name: 'run_program', input: { code: PROGRAM } }]), reply('The static native analysis is saved; no world build was started.'))
  const sent = await lineCalls(h, 'talk', 'start_helper', { task: 'Construct and calculate a native production example, then return the analysis facts.' })
  assert.equal(sent.isError, false, sent.content)
  await waitFor('helper completed its native calculation', () => h.agent.helperOverview().recent.find((row) => row.id === 'h1'), 15_000)
  await h.agent.whenIdle()
  assert.match(h.helper!.lastUserText(1), /"averageEuT":2/)
  const records = await planner.list()
  assert.equal(records.total, 3)
  assert.equal(new Set(records.items.map((row) => row.id)).size, 3)
  for (const item of records.items) {
    assert.equal(item.outcome, 'calculated')
    const record = await planner.store.get(item.id)
    assert.equal((record.project as { name: string }).name, 'Native plan constructed inside the brain sandbox')
  }
  for (const method of ['task.start', 'bot.command', 'screen.click', 'blueprint.put']) assert.deepEqual(h.game.callsOf(method), [], method)
})

it('stopping a brain turn cancels its planner invocation and does not poison the next turn', async (t) => {
  const tmp = tmpDir()
  const engine = new PlannerEngine()
  // Pause at the scheduling boundary, then forward to the real native engine.
  // No result or mathematical behavior is faked; native worker interruption is tested separately.
  const original = engine.calculateDetailed.bind(engine)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const observed: { entered: boolean; signal?: AbortSignal } = { entered: false }
  engine.calculateDetailed = async (project, options) => {
    observed.entered = true
    observed.signal = options?.signal
    await gate
    return original(project, options)
  }
  const planner = new PlannerWorkspace({ directory: path.join(tmp.dir, 'production-plans'), engine })
  const h = makeAgent({ dir: tmp.dir, planner })
  t.after(async () => {
    release()
    await Promise.all([h.agent.stop(), planner.close()])
    tmp.cleanup()
  })
  h.llm.enqueue(reply('', [{ name: 'production_plan', input: { action: 'solve', project: NATIVE_PROJECT_EXAMPLE } }]))
  h.agent.handleEvent(told('Calculate a production plan, without starting any world action.'))
  await waitFor('planner entered from the actual work line', () => observed.entered)
  assert.ok(observed.signal, 'the turn AbortSignal must reach the calculator')
  const stopping = h.agent.stopWork('Stop the current calculation.', 'panel')
  await waitFor('turn signal aborted', () => observed.signal?.aborted)
  release()
  await stopping
  await h.agent.whenIdle()
  const canceled = await planner.list()
  assert.equal(canceled.total, 1)
  assert.equal((await planner.store.get(canceled.items[0]!.id)).error?.code, 'aborted')
  const next = await lineCalls(h, 'work', 'production_plan', { action: 'solve', project: NATIVE_PROJECT_EXAMPLE })
  assert.equal(next.isError, false, next.content)
  assert.equal((await planner.list()).total, 2)
  assert.deepEqual(h.game.callsOf('task.start'), [])
})
