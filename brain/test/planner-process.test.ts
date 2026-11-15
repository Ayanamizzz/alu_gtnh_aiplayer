// Whole brain process + real HTTP model adapter + sandbox + native calculator.
// The HTTP model is scripted, not a claim of autonomous model planning. No game connection or real key.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { it } from 'node:test'
import { ConfigStore } from '../src/store/config.ts'
import { tmpDir } from './helpers.ts'

async function until<T>(probe: () => Promise<T | false>, label: string, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const value = await probe()
    if (value !== false) return value
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

it('a real packaged-capable brain plans through a scripted HTTP model while the game is unconfigured', { timeout: 90_000 }, async () => {
  const tmp = tmpDir('planner-process-')
  const root = path.resolve(process.env.AIPLAYER_QA_BRAIN_ROOT ?? path.join(import.meta.dirname, '..'))
  const pack = path.resolve(process.env.AIPLAYER_QA_PACKDATA ?? path.join(tmp.dir, 'empty-packdata'))
  if (process.env.AIPLAYER_QA_PACKDATA) assert.ok(fs.statSync(pack).isDirectory())
  else fs.mkdirSync(pack, { recursive: true })
  const ref = process.env.AIPLAYER_QA_RECIPE_REF
  if (ref !== undefined) assert.match(ref, /^\d+$/)
  const config = new ConfigStore(tmp.dir)
  config.update(c => {
    c.panel.password = 'planner-process-only'
    c.bot.name = 'PlannerProcessQA'
    c.bot.wantOnline = false
    c.bridge.token = ''; c.bridge.tokenFile = ''; c.providers = []
  })
  const program = `
const contract = await tool('production_plan', {action:'reference',reference:'project',query:'interface FactoryProject'});
if (!contract.ok || !contract.data.total) throw new Error('Native contract not available: '+contract.text);
const d = await tool('production_plan', {action:'describe'${ref !== undefined ? `,refs:[${ref}]` : ''}});
if (!d.ok) throw new Error(d.text);
let p = ${ref !== undefined ? 'd.data.projectTemplate' : 'd.data.exampleProject'};
if (${ref !== undefined}) {
  const r=p.recipes[0], n=p.nodes[0], out=r.outputs[0];
  p.storages=[]; p.edges=[]; n.solvePin=100;
  const handle=(side,x)=>side+':'+x.kind+':'+encodeURIComponent(x.id);
  for (let i=0;i<r.inputs.length;i++) {
    const input=r.inputs[i]; if (input.consumed===false) continue;
    const id='supply-'+i;
    p.storages.push({id,kind:input.kind,resourceId:input.id,targetPerSecond:-input.amount/(out.amount*(out.chance??1)),targetMode:'at-most',position:{x:-200,y:i*100}});
    p.edges.push({id:'in-'+i,source:id,target:n.id,sourceHandle:handle('output',input),targetHandle:handle('input',input),resourceKind:input.kind,resourceId:input.id});
  }
  p.storages.push({id:'product',kind:out.kind,resourceId:out.id,targetPerSecond:1,targetMode:'at-least',drainMode:'product',position:{x:200,y:0}});
  p.edges.push({id:'out',source:n.id,target:'product',sourceHandle:handle('output',out),targetHandle:handle('input',out),resourceKind:out.kind,resourceId:out.id});
}
p.name='Brain process constructed this native plan';
const first=await tool('production_plan',{action:'solve',project:p});
if (!first.ok) throw new Error(first.text);
const saved=await tool('production_plan',{action:'read',id:first.data.id,section:'machines'});
if (!saved.ok) throw new Error(saved.text);
return {id:first.data.id,nativeContractFound:true,staticAnalysis:saved.data.summary.staticAnalysis,averageEuT:saved.data.summary.averageEuT,machines:saved.data.items};
`
  let calls = 0, completed = false, toolText = '', indexVisible = false
  const model = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      calls++
      indexVisible ||= body.tools.some((entry: { function?: { description?: string } }) => entry.function?.description?.includes('production_plan'))
      const result = body.messages.findLast((message: { role: string }) => message.role === 'tool')
      let message
      if (result) {
        toolText = String(result.content)
        completed = true
        message = { role: 'assistant', content: 'Scripted QA finished. This is a saved static analysis, not a world build.' }
      } else message = { role: 'assistant', content: null, tool_calls: [{ id: 'planner-qa-call', type: 'function', function: { name: 'run_program', arguments: JSON.stringify({ code: program, timeout: 30 }) } }] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'scripted-planner', model: 'scripted-planner', choices: [{ index: 0, message, finish_reason: result ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const modelPort = (model.address() as net.AddressInfo).port
  const reservation = net.createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const panelPort = (reservation.address() as net.AddressInfo).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const child = spawn(process.execPath, ['--disable-sigusr1', path.join(root, 'src/main.ts')], {
    cwd: tmp.dir,
    env: { PATH: path.dirname(process.execPath), AIPLAYER_DATA_DIR: tmp.dir, AIPLAYER_PACKDATA: pack,
      AIPLAYER_PANEL_HOST: '127.0.0.1', AIPLAYER_PANEL_PORT: String(panelPort), AIPLAYER_BRIDGE_PORT: '25682' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const exited = once(child, 'exit')
  const origin = `http://127.0.0.1:${panelPort}`
  let cookie = ''
  const api = async (method: string, route: string, data?: unknown) => {
    const response = await fetch(`${origin}/api${route}`, { method,
      headers: { cookie, origin, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const json = await response.json() as any
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(json)}\n${output}`)
    return { response, json }
  }
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Brain exited before readiness: ${output}`)
      try { return (await fetch(`${origin}/api/session`)).ok } catch { return false }
    }, 'brain panel readiness')
    const login = await api('POST', '/login', { password: 'planner-process-only' })
    cookie = login.response.headers.getSetCookie()[0]!.split(';')[0]!
    const created = await api('POST', '/providers', { kind: 'openai-chat', label: 'Scripted QA only', baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'scripted-not-a-real-key', model: 'scripted-planner' })
    await api('POST', '/models/use', { line: 'talk', providerId: created.json.provider.id, modelId: created.json.provider.models[0].id })
    await api('POST', '/command', { text: 'Run the offline native production planning QA. Do not connect to or act in the game.' })
    await until(async () => completed ? true : false, 'model receives the native tool result')
    assert.ok(indexVisible, 'the actual model request must expose the production library')
    assert.match(toolText, /"staticAnalysis":true/, toolText)
    assert.match(toolText, /"nativeContractFound":true/, toolText)
    const list = (await api('GET', '/production')).json
    assert.equal(list.total, 1, toolText)
    const record = (await api('GET', `/production/export?id=${list.items[0].id}`)).json
    assert.equal(record.outcome, 'calculated')
    assert.equal(record.project.name, 'Brain process constructed this native plan')
    assert.equal(record.report.stale ?? false, false)
    assert.ok(record.explanation.machines.some((machine: { fractionalMachines: number }) => machine.fractionalMachines > 0))
    assert.ok(record.explanation.goals.every((goal: { met: boolean }) => goal.met))
    assert.ok(calls >= 2)
    if (ref !== undefined) assert.ok(record.provenance.some((source: { status: string }) => source.status === 'local-current'))
    if (process.env.AIPLAYER_QA_RECEIPT) fs.writeFileSync(process.env.AIPLAYER_QA_RECEIPT, JSON.stringify({ root, calls, indexVisible, toolText, record }, null, 2))
  } finally {
    child.kill('SIGTERM')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 12_000)
    try { await exited } finally { clearTimeout(timeout) }
    model.closeAllConnections()
    await new Promise<void>(resolve => model.close(() => resolve()))
    tmp.cleanup()
  }
  assert.equal(child.exitCode, 0, `The brain must close cleanly: ${output}`)
})
