// task.list entries captured by live-process-receipt.ts on GTNH. Replay through the same event and routine
// boundaries as a connected body; no task formatter fields or recipe results invented by the harness.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { it } from 'node:test'
import { DesignWorkspace } from '../src/design/index.ts'
import type { TaskInfo } from '../src/bridge/protocol.ts'
import { makeAgent, reply, told } from './agent-harness.ts'
import { tmpDir, waitFor } from './helpers.ts'

function captured(file: string): Record<string, TaskInfo> {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/process-receipts-${file}.json`, import.meta.url), 'utf8'))
}

it('旧身体加工完成通知：西箱新增两个外壳、PE 是余液；两块退料只报一笔', async t => {
  const h = makeAgent(); t.after(h.cleanup)
  const tasks = captured('legacy')
  for (const task of [tasks.beforeCasings!, tasks.beforeReturn!]) {
    const before = h.llm.requests.length
    h.agent.handleEvent({ type: 'task_ended', time: Date.now(), task })
    await h.agent.whenIdle()
    const text = h.llm.lastUserText(before)
    if (task.state === 'done') {
      assert.match(text, /2× gregtech:gt.blockmachines\/11.*west face/)
      assert.match(text, /tank stock at end: 15516 of 64000 mB/)
      assert.doesNotMatch(text, /what it made is a fluid|fluid products of/)
    } else {
      assert.match(text, /inputs actually returned: 2× minecraft:bedrock/)
      assert.equal(text.match(/2× minecraft:bedrock/g)?.length, 1)
    }
  }
})

it('例程等组装机：同一种容量瓶既有成品也有退料，分列实收且旧 outputs 保持背包净增', async t => {
  const tmp = tmpDir(), h = makeAgent({ dir: tmp.dir, design: new DesignWorkspace({ dataDir: tmp.dir }) })
  t.after(async () => { await h.agent.stop(); tmp.cleanup() })
  const task = captured('current').flasks!
  h.game.handlers['task.start'] = () => ({ task: { ...task, state: 'queued', result: undefined } })
  h.llm.enqueue(reply('', [{ name: 'start_routine', input: { code: `const r = await tool('process_items',{machine:{x:10,y:190,z:7},inputs:[{id:'gregtech:gt.Volumetric_Flask',count:32}],circuit:1,wait:5}); const d=r.data.result; return [d.outputsBasis,d.outputs[0].count,d.collected[0].count,d.returnedInputs[0].count,r.text]` } }]), reply(''))
  h.agent.handleEvent(told('加工容量瓶并核收据'))
  await waitFor('process requested', () => h.game.callsOf('task.start').length === 1)
  h.agent.handleEvent({ type: 'task_ended', time: Date.now(), task })
  await waitFor('routine result', () => h.agent.status().routine?.status === 'done')
  const [basis, net, collected, returned, text] = JSON.parse(h.agent.status().routine!.value!)
  assert.equal(basis, 'positiveInventoryDeltaSinceLoad')
  // Independent bag inspection: the configured and blank flasks are visibly different capacities, same id/meta.
  assert.equal(collected, 11); assert.equal(returned, 19); assert.equal(net, 30)
  assert.match(text, /collected from output: 11× gregtech:gt.Volumetric_Flask/)
  assert.match(text, /inputs actually returned: 19× gregtech:gt.Volumetric_Flask/)
  assert.doesNotMatch(text, /30× gregtech:gt.Volumetric_Flask/)
})
