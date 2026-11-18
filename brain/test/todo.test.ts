// 工作清单（store/todo.ts、tools/todo.ts、agent/lines.ts 里叫醒干活线的那一段）：主人一次交代了一串事，
// “还要做什么”记在一张两条线都能看、都能改的清单上，不只留在对话历史里。
// 入口是整个 agent（h.agent）：模型调工具 todo、每一轮的“当前状态”、干活线停下来以后被叫醒；自动下线用真的 Presence 接上 h.agent.busy()。
// 面板接口（/api/todo）在 panel.test.ts。

import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/agent/events.ts'
import { describe, it } from 'node:test'
import { Presence } from '../src/agent/presence.ts'
import { LlmError } from '../src/llm/index.ts'
import { TODO_DONE_KEPT } from '../src/store/todo.ts'
import { chat, lineCalls, makeAgent, reply, taskEnded, told } from './agent-harness.ts'
import type { AgentHarness, MakeAgentOptions } from './agent-harness.ts'
import { sleep, waitFor } from './helpers.ts'

/** 大脑的钟：2025-01-15 22:30（本地时间）起，测试自己往前拨。 */
const T0 = new Date(2025, 0, 15, 22, 30).getTime()
const MIN = 60_000

function setup(t: { after(fn: () => void | Promise<void>): void }, opts: MakeAgentOptions = {}) {
  const clock = { t: T0 }
  const h = makeAgent({ now: () => clock.t, ...opts })
  t.after(async () => {
    await h.agent.stop()
    h.cleanup()
  })
  return { h, clock }
}

/** 一次请求的“当前状态”里，工作清单那几行（到 Real time 为止）；没有就是 undefined。 */
function listInState(text: string): string[] | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('To-do list (todo;'))
  if (start < 0) return undefined
  const end = lines.findIndex((l, i) => i > start && l.startsWith('Real time:'))
  return lines.slice(start, end)
}

/** 干活线因为清单被叫醒的那几次：每次那一轮开头看到的那句话。 */
function nudges(h: AgentHarness): string[] {
  return h.llm.requests.map((_, i) => h.llm.lastUserText(i)).flatMap((text) => text.split('\n').filter((l) => l.includes('[系统] 你停下来了')).map((l) => l.replace(/^\[[\d:]+\] /, '')))
}

describe('工作清单：两条线写、看', () => {
  it('对话线加的、干活线改的是同一张；结果是整张清单，写明这次改了什么、谁什么时候写的；两条线每一轮的“当前状态”里都列着没做完的、在等人的和最近做完的', async (t) => {
    // 叫醒干活线的那一段这里不看：等得够久，测试期间不会发生
    const { h, clock } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    const added = await lineCalls(h, 'talk', 'todo', {
      add: [{ text: '把东边箱子里的钢锭搬进仓库' }, { text: '修二号高炉', note: '主人说不急' }, { text: '挖完北边的矿洞' }],
    })
    assert.deepEqual(added.content.split('\n'), [
      'Changed: added #1, #2, #3.',
      'To-do list: 3 not done, 0 waiting, 0 done.',
      '- #1 not done: 把东边箱子里的钢锭搬进仓库 (the talk line, 22:30)',
      '- #2 not done: 修二号高炉 (the talk line, 22:30) — note: 主人说不急',
      '- #3 not done: 挖完北边的矿洞 (the talk line, 22:30)',
    ])
    clock.t += 2 * MIN
    const changed = await lineCalls(h, 'work', 'todo', { change: [{ id: 1, state: 'done' }, { id: 2, waitingFor: 'Steve 把高炉的钥匙给我' }, { id: 3, note: '矿洞口有岩浆' }] })
    assert.deepEqual(changed.content.split('\n'), [
      'Changed: #1 marked done; #2 marked waiting; #3 changed.',
      'To-do list: 1 not done, 1 waiting, 1 done.',
      '- #2 waiting for Steve 把高炉的钥匙给我: 修二号高炉 (the talk line, 22:30) — note: 主人说不急',
      '- #3 not done: 挖完北边的矿洞 (the talk line, 22:30) — note: 矿洞口有岩浆',
      'Done (latest first):',
      '- #1 done 22:32: 把东边箱子里的钢锭搬进仓库',
    ])
    // 存下的是谁写的、谁改的
    assert.deepEqual(
      h.todo.list().map((i) => [i.id, i.state, i.by, i.changedBy ?? null]),
      [
        [1, 'done', 'talk', 'work'],
        [2, 'waiting', 'talk', 'work'],
        [3, 'open', 'talk', 'work'],
      ],
    )
    // 不带参数：就是看
    clock.t += MIN
    const looked = await lineCalls(h, 'talk', 'todo', {})
    assert.equal(looked.content, changed.content.split('\n').slice(1).join('\n'))
    // 两条线下一轮开头的“当前状态”里都列着
    const expected = [
      'To-do list (todo; the same list for both lines and your owner): 1 not done, 1 waiting, 1 done',
      '- #2 waiting for Steve 把高炉的钥匙给我: 修二号高炉 (the talk line, 22:30) — note: 主人说不急',
      '- #3 not done: 挖完北边的矿洞 (the talk line, 22:30) — note: 矿洞口有岩浆',
      'Latest done:',
      '- #1 done 22:32: 把东边箱子里的钢锭搬进仓库',
    ]
    assert.deepEqual(listInState(h.talk.lastUserText(h.talk.requests.length - 2)), expected)
    h.agent.handleEvent(told('高炉的事先放着'))
    await h.agent.whenIdle()
    assert.deepEqual(listInState(h.llm.lastUserText(h.llm.requests.length - 1)), expected)
  })

  it('一次改动里有一处不对，整次不做，说清哪几处；做完的只留最近 20 条，清掉的照实列出', async (t) => {
    const { h, clock } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    await lineCalls(h, 'work', 'todo', { add: [{ text: '搬钢锭' }, { text: '修高炉' }] })
    const refused = await lineCalls(h, 'work', 'todo', { change: [{ id: 1, state: 'done' }, { id: 2, state: 'waiting' }, { id: 9, text: '别的' }] })
    assert.equal(refused.isError, true)
    assert.equal(refused.content, 'Nothing was changed: #2: "waiting" needs waitingFor: who or what it waits for. #9 is not on the list.')
    assert.deepEqual(h.todo.list().map((i) => i.state), ['open', 'open'])
    // 一条一条做完：做完的第 21 条进来时，最早做完的那条清掉
    const many = Array.from({ length: TODO_DONE_KEPT }, (_, i) => ({ text: `第 ${i + 3} 件` }))
    await lineCalls(h, 'work', 'todo', { add: many })
    for (let id = 1; id <= TODO_DONE_KEPT; id++) {
      clock.t += MIN
      h.todo.apply({ change: [{ id, state: 'done' }] }, 'work', clock.t)
    }
    clock.t += MIN
    const res = await lineCalls(h, 'work', 'todo', { change: [{ id: 21, state: 'done' }] })
    assert.equal(res.content.split('\n')[0], 'Changed: #21 marked done; cleared #1 (only the latest done ones are kept).')
    assert.deepEqual(
      h.todo.list().filter((i) => i.state === 'done').map((i) => i.id),
      Array.from({ length: TODO_DONE_KEPT }, (_, i) => i + 2),
    )
    // 做完的重新打开
    const reopened = await lineCalls(h, 'talk', 'todo', { change: [{ id: 21, state: 'open' }] })
    assert.equal(reopened.content.split('\n')[0], 'Changed: #21 reopened.')
    assert.equal(h.todo.list().find((i) => i.id === 21)?.doneAt, undefined)
  })

  it('重启以后清单还在：状态里照样列着，编号接着往下排', async (t) => {
    const { h } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    await lineCalls(h, 'talk', 'todo', { add: [{ text: '把东边箱子里的钢锭搬进仓库' }, { text: '修二号高炉' }] })
    await h.agent.stop()
    const again = h.restart({ timing: { todoNudgeMs: 600_000 }, now: () => T0 })
    t.after(() => again.agent.stop())
    again.agent.handleEvent(told('接着干'))
    await again.agent.whenIdle()
    assert.deepEqual(listInState(again.llm.lastUserText(again.llm.requests.length - 1)), [
      'To-do list (todo; the same list for both lines and your owner): 2 not done, 0 waiting, 0 done',
      '- #1 not done: 把东边箱子里的钢锭搬进仓库 (the talk line, 22:30)',
      '- #2 not done: 修二号高炉 (the talk line, 22:30)',
    ])
    const added = await lineCalls(again, 'work', 'todo', { add: [{ text: '挖矿洞' }] })
    assert.equal(added.content.split('\n')[0], 'Changed: added #3.')
  })
})

describe('工作清单：提示词', () => {
  it('两条线的提示词里写着有这张清单（只写事实）：两条线和主人共用、每一轮都看得到、有没做的不自动下线、干活线停下来时会被叫醒', async (t) => {
    const { h } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    await lineCalls(h, 'talk', 'todo', {})
    await lineCalls(h, 'work', 'todo', {})
    for (const req of [h.talk.requests[0]!, h.llm.requests[0]!]) {
      assert.match(req.system, /两条线和主人共用一张/)
      assert.match(req.system, /有待办（open）就不会自动下线/)
      assert.match(req.system, /继续收到待办/)
    }
  })
})

describe('工作清单：自动下线', () => {
  /** 一个只有它自己在线、什么任务都没有的服务器上的 Presence，“手上有没有事”问的是真的两条线。 */
  function presenceOf(h: AgentHarness) {
    const world = { now: 0, away: false, calls: [] as string[], onInfo: undefined as (() => void) | undefined }
    const presence = new Presence({
      settings: () => ({ botName: 'Alu', wantOnline: true, enabled: true, idleMinutes: 5, away: world.away }),
      setAway: (away) => (world.away = away),
      bridge: {
        serverInfo: async () => {
          world.onInfo?.()
          return { players: [{ name: 'Alu', isBot: true }] }
        },
        taskList: async () => ({ active: null, queue: [] }),
        botStatus: async () => ({ online: !world.away }),
        botSpawn: async () => {
          world.calls.push('spawn')
          return {}
        },
        botDespawn: async () => {
          world.calls.push('despawn')
          return {}
        },
      },
      connected: () => true,
      online: () => !world.away,
      busy: () => h.agent.busy(),
      log: () => {},
      now: () => world.now,
    })
    const after = async (minutes: number) => {
      world.now += minutes * MIN
      await presence.tick()
    }
    return { world, presence, after }
  }

  it('清单上有没做的就不下线；剩下的都标成在等人了，照样过 5 分钟下线', async (t) => {
    const { h } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    const p = presenceOf(h)
    await p.presence.onReady()
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    await p.after(0)
    await p.after(10)
    assert.deepEqual(p.world.calls, [])
    h.todo.apply({ change: [{ id: 1, waitingFor: 'Steve 把钥匙给我' }] }, 'talk', T0)
    await p.after(0)
    await p.after(5)
    assert.deepEqual(p.world.calls, ['despawn'])
  })

  it('无人发新指令：只回答看过棉苗后仍被叫醒，挂起棉苗后接着收圆石；收货标完成才开始五分钟休息', async (t) => {
    const { h } = setup(t)
    const p = presenceOf(h)
    await p.presence.onReady()
    h.llm.enqueue(
      reply('刚才看过棉苗，尚未成熟。'),
      reply('', [{ name: 'todo', input: { change: [{ id: 1, waitingFor: '棉苗成熟' }] } }]), reply(''),
      reply('', [{ name: 'withdraw_items', input: { container: { x: 10, y: 64, z: -2 }, items: [{ id: 'minecraft:cobblestone', count: 1 }] } }]), reply(''),
    )
    h.todo.apply({ add: [{ text: '收棉花' }, { text: '从箱子收 1 个圆石' }] }, 'owner', T0)
    await waitFor('the remaining stone task started without a new command', () => h.game.callsOf('task.start').length > 0)
    await h.agent.whenIdle()
    assert.deepEqual(h.todo.list().map(i => i.state), ['waiting', 'open'])
    assert.equal(nudges(h).length, 3)
    assert.doesNotMatch(nudges(h)[2]!, /#1 /)
    assert.match(nudges(h)[2]!, /#2 从箱子收 1 个圆石/)
    await p.after(6)
    assert.equal(p.world.away, false)
    h.llm.enqueue(reply('', [{ name: 'todo', input: { change: [{ id: 2, state: 'done' }] } }]), reply(''))
    h.agent.handleEvent(taskEnded('t1', 'done', { type: 'withdraw', result: { moved: 1 } }))
    await h.agent.whenIdle()
    assert.deepEqual(h.todo.list().map(i => i.state), ['waiting', 'done'])
    await p.after(0)
    await p.after(4)
    assert.deepEqual(p.world.calls, [])
    await p.after(1)
    assert.deepEqual(p.world.calls, ['despawn'])
  })

  it('下线前再看一遍：就在那一会儿清单上多了一件没做的，不下线', async (t) => {
    const { h } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    const p = presenceOf(h)
    await p.presence.onReady()
    await p.after(0)
    // 满 5 分钟要下线了，下线前问服务器上有谁的那一刻，主人在面板上加了一件
    p.world.onInfo = () => h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    await p.after(5)
    assert.deepEqual([p.world.calls, p.world.away], [[], false])
  })
})

describe('工作清单：干活线停下来以后被叫醒', () => {
  it('只剩等待项不催；重新打开同一条以后，即使编号没变也继续做', async (t) => {
    const { h } = setup(t)
    h.llm.enqueue(reply('', [{ name: 'todo', input: { change: [{ id: 1, waitingFor: '高炉钥匙' }] } }]), reply(''))
    h.todo.apply({ add: [{ text: '修高炉' }] }, 'owner', T0)
    await waitFor('item marked waiting', () => h.todo.list()[0]?.state === 'waiting')
    await h.agent.whenIdle()
    await sleep(100)
    assert.equal(nudges(h).length, 1)
    h.todo.apply({ change: [{ id: 1, state: 'open' }] }, 'owner', T0)
    await waitFor('same id wakes work again', () => nudges(h).length >= 2)
    assert.match(nudges(h)[1]!, /#1 修高炉/)
  })

  it('清单提醒已经排队，又把唯一一项挂起：不为旧提醒调模型，同批真人交事仍然处理', async (t) => {
    const { h } = setup(t, { timing: { debounceMs: 100, todoNudgeMs: 5 } })
    h.todo.apply({ add: [{ text: '找钥匙开门' }] }, 'owner', T0)
    const queued = () => h.persisted.state?.queue.some(ev => ev.type === 'todo')
    await waitFor('nudge queued before model dispatch', queued)
    h.todo.apply({ change: [{ id: 1, waitingFor: '钥匙' }] }, 'owner', T0)
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 0)
    h.todo.apply({ change: [{ id: 1, state: 'open' }] }, 'owner', T0)
    await waitFor('reopened item queued', queued)
    h.agent.handleEvent(told('看看基地大门'))
    h.todo.apply({ change: [{ id: 1, waitingFor: '钥匙' }] }, 'owner', T0)
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 1)
    assert.match(h.llm.lastUserText(0), /看看基地大门/)
    assert.deepEqual(nudges(h), [])
  })

  it('今日额度用尽不催模型；额度恢复，无人说话也会继续已有待办', async (t) => {
    const { h } = setup(t, { settings: { dailyTokenLimit: 100 }, timing: { retryDelaysMs: [50] } })
    h.usedTokens.value = 100
    h.todo.apply({ add: [{ text: '清点仓库' }] }, 'owner', T0)
    await sleep(120)
    assert.equal(h.llm.requests.length, 0)
    h.usedTokens.value = 0
    await waitFor('todo resumed when quota became available', () => nudges(h).length > 0)
  })

  it('身体查询偶尔失败、或上面有未跟踪的任务：不抢身体，恢复空闲后不用新事件', async (t) => {
    const { h } = setup(t)
    let checks = 0
    h.game.handlers['task.list'] = () => {
      if (++checks === 1) throw new Error('一次查询没收到答复')
      return { active: { id: 'other', type: 'goto', state: 'running' }, queue: [], recent: [] }
    }
    h.todo.apply({ add: [{ text: '清点仓库' }] }, 'owner', T0)
    await waitFor('body checked again after a transient error', () => checks >= 2)
    assert.equal(h.llm.requests.length, 0)
    h.game.handlers['task.list'] = () => ({ active: null, queue: [], recent: [] })
    await waitFor('free body available for open work', () => nudges(h).length > 0)
  })

  it('对话线正在想的时候清单变了：先不叫，等它想完（它可能正要把事交过来）', async (t) => {
    const { h } = setup(t)
    let answer: ((r: ReturnType<typeof reply>) => void) | undefined
    // 一次不回来的模型调用：测试放行；测试失败收尾（stop）时被打断，和真的模型客户端一样以 aborted 失败
    h.talk.enqueue(
      (req) =>
        new Promise((resolve, reject) => {
          answer = resolve
          req.signal?.addEventListener('abort', () => reject(new LlmError('aborted', 'stopped')))
        }),
    )
    h.agent.handleEvent(chat('Steve', 'Alu 记一下：修二号高炉'))
    await waitFor('the talk line is thinking', () => answer !== undefined)
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'talk', T0)
    await sleep(200)
    assert.equal(h.llm.requests.length, 0)
    answer!(reply(''))
    await waitFor('woken by the list after the talk line was done', () => nudges(h).length === 1)
  })

  it('大脑重启：清单上有没做的、干活线又没有别的事接着做，起来过一小会儿叫醒它；它不在线（身体说它不在游戏里）就不叫', async (t) => {
    const { h } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    await h.agent.stop()
    const again = h.restart({ now: () => T0, timing: {} })
    t.after(() => again.agent.stop())
    await waitFor('woken by the list after the restart', () => nudges(again).length === 1)
    assert.equal(nudges(again)[0], '[系统] 你停下来了（身体上没有在跑或排着的任务、没有例程、也没有在等的回答），工作清单上还有 1 件没做完、也没标成在等人：#1 修二号高炉')
    await again.agent.whenIdle()
    // 它下线了：被叫醒那一轮看到自己不在线，之后清单再变也不叫
    again.game.online = false
    again.agent.handleEvent(told('看看还在不在'))
    await waitFor('the turn after going offline', () => again.llm.requests.length >= 2)
    await again.agent.whenIdle()
    again.todo.apply({ add: [{ text: '挖矿洞' }] }, 'owner', T0)
    await sleep(200)
    assert.deepEqual([again.llm.requests.length, nudges(again).length], [2, 1])
  })

  it('被叫停以后（审查找到的三条路）：大脑重启了照样不叫；叫停时正在收尾的那一轮（它的事来得比叫停早）收完也不解开；为叫停以后交来的事走完一轮才解开', async (t) => {
    const { h } = setup(t)
    h.todo.apply({ add: [{ text: '拆掉那台旧机器' }] }, 'owner', T0)
    await waitFor('woken by the list', () => nudges(h).length === 1)
    await h.agent.whenIdle()
    await h.agent.stopWork('先别干了', 'panel')
    // 叫停时正在收尾的那一轮：它是为叫停以前就来的事走的
    ;(h.agent as unknown as { workEnded(triggers: AgentEvent[]): void }).workEnded([told('拆掉那台旧机器', [], T0 - 60_000)])
    h.todo.apply({ add: [{ text: '补火把' }] }, 'owner', T0)
    await sleep(200)
    assert.equal(nudges(h).length, 1)
    // 大脑重启：还是叫停着
    await h.agent.stop()
    const again = h.restart({ timing: {} })
    t.after(() => again.agent.stop())
    await sleep(300)
    // 重启前后用的是同一个假模型：数的还是重启前那一次
    assert.equal(nudges(again).length, 1)
    // 交来新的事，它走完这一轮：解开，清单上没做的再叫醒它
    again.agent.handleEvent(told('接着干吧'))
    await waitFor('woken by the list after new work', () => nudges(again).length === 2)
  })

  it('下线时清单上多了没做的：那时不叫（叫醒它也做不了）；它一上线就叫（审查找到的：原来要等别的事来才会再看）', async (t) => {
    const { h } = setup(t)
    h.game.online = false
    h.agent.handleEvent({ type: 'despawned', time: Date.now(), reason: 'idle' })
    await h.agent.whenIdle()
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    await sleep(200)
    assert.equal(nudges(h).length, 0)
    h.game.online = true
    h.agent.handleEvent({ type: 'spawned', time: Date.now() })
    await waitFor('woken by the list after coming online', () => nudges(h).length === 1)
  })

  it('只往清单加事不处理，提醒变慢、有日志，超过原来八次仍可自己继续', async (t) => {
    const { h } = setup(t, { timing: { todoNudgeMs: 5, retryDelaysMs: [25, 55] } })
    const times: number[] = []
    h.llm.auto = (seen) => {
      if (!seen.includes('[系统] 你停下来了')) return
      times.push(performance.now())
      h.agent.handleEvent(chat('Steve', '今天天气真好')) // 无关的公屏闲聊不会把退避打回第一档
      return reply('', [{ name: 'todo', input: times.length < 9 ? { add: [{ text: '再检查仓库' }] } : { change: h.todo.list().map(i => ({ id: i.id, waitingFor: '仓库钥匙' })) } }])
    }
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    await waitFor('the worker can handle its list after nine nudges', () => h.todo.list().every(i => i.state === 'waiting'))
    assert.equal(times.length, 9)
    assert.ok(times[8]! - times[7]! >= 50, 'at the slower retry interval, not the initial 5 ms')
    assert.equal(h.log.recent(0, 500).filter(e => e.kind === 'info' && e.text.includes('放慢')).length, 1)
  })

  it('不叫醒的时候：只剩在等人的；身体上还有任务在跑；它提了问在等回答；被叫停了（等有新的事交给它为止）', async (t) => {
    const { h } = setup(t)
    // 只剩在等人的
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    h.todo.apply({ change: [{ id: 1, waitingFor: 'Steve 把钥匙给我' }] }, 'owner', T0)
    await sleep(200)
    assert.equal(h.llm.requests.length, 0)
    // 身体上有任务在跑（不是它这一轮开的，大脑没盯着）
    h.game.handlers['task.list'] = () => ({ active: { id: 't7', type: 'goto', state: 'running' }, queue: [], recent: [] })
    h.todo.apply({ add: [{ text: '挖完北边的矿洞' }] }, 'owner', T0)
    await sleep(200)
    assert.equal(h.llm.requests.length, 0)
    h.game.handlers['task.list'] = () => ({ active: null, queue: [], recent: [] })
    // 它提了问、在等对话线的回答
    h.llm.enqueue(reply('', [{ name: 'report', input: { text: '矿洞从哪边挖？', question: true } }]), reply(''))
    h.agent.handleEvent(told('看看矿洞'))
    await waitFor('the question reached the talk line', () => h.talk.requests.length >= 1)
    await h.agent.whenIdle()
    await sleep(200)
    assert.deepEqual([h.llm.requests.length, nudges(h)], [2, []])
    // 回答到了（对话线带话过去）：它走完这一轮停下，清单上还有没做的，叫醒它
    await lineCalls(h, 'talk', 'tell_worker', { text: '从西边挖' })
    await waitFor('woken by the list after the answer', () => nudges(h).length === 1)
    await h.agent.whenIdle()
    // 被叫停：之后清单再变也不叫，等有新的事交给它
    await h.agent.stopWork('先别干了', 'panel')
    const before = h.llm.requests.length
    h.todo.apply({ add: [{ text: '补火把' }] }, 'owner', T0)
    await sleep(200)
    assert.equal(h.llm.requests.length, before)
    h.agent.handleEvent(told('接着干吧'))
    await waitFor('woken by the list after new work', () => nudges(h).length === 2)
    assert.match(nudges(h)[1]!, /工作清单上还有 2 件没做完、也没标成在等人：#2 挖完北边的矿洞、#3 补火把$/)
  })
})
