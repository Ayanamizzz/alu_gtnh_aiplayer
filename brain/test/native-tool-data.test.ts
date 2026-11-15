import assert from 'node:assert/strict'
import { it } from 'node:test'
import { runTool, schemaForModel } from '../src/tools/index.ts'
import type { Tool, ToolContext } from '../src/tools/index.ts'
import { useLocalNames } from '../src/tools/format.ts'
import { int, obj } from '../src/tools/schema.ts'

it('the real tool dispatcher preserves an explicitly native JSON payload and English data', async (t) => {
  useLocalNames({
    get: (id) => id === 'minecraft:coal' ? { name: '煤', en: 'Coal' } : undefined,
    byEnglishName: () => undefined,
  })
  t.after(() => useLocalNames(undefined))
  const native = JSON.parse('{"schemaVersion":1,"recipes":{"r":{"inputs":[{"id":"minecraft:coal","name":"Coal","amount":1,"kind":"item"}]}},"metadata":{"future":"4","optional":null},"__proto__":{"testMarker":true}}')
  const tool: Tool = {
    name: 'native_payload_test', description: 'Return the supplied interchange data.', rawData: true,
    inputSchema: obj({ project: { type: 'object', properties: {}, additionalProperties: true }, limit: int() }, ['project']),
    async run(_ctx, input) { return { content: 'Preserved.', data: input } },
  }
  const result = await runTool([tool], {} as ToolContext, tool.name, { project: native, limit: '3', ignored: true })
  assert.equal(result.isError, undefined, result.content)
  assert.deepEqual(result.data, { project: native, limit: 3 })
  assert.equal(({} as Record<string, unknown>).testMarker, undefined)
  assert.equal(schemaForModel(tool.inputSchema).additionalProperties, undefined)
  const properties = schemaForModel(tool.inputSchema).properties as Record<string, Record<string, unknown>>
  assert.equal(properties.project?.additionalProperties, true)
})

it('ordinary tool data still uses local display names and drops undeclared arguments', async (t) => {
  useLocalNames({
    get: (id) => id === 'minecraft:coal' ? { name: '煤', en: 'Coal' } : undefined,
    byEnglishName: () => undefined,
  })
  t.after(() => useLocalNames(undefined))
  const tool: Tool = {
    name: 'ordinary_payload_test', description: 'Return an ordinary observation.', inputSchema: obj({ limit: int() }),
    async run(_ctx, input) { return { content: 'Observed.', data: { input, item: { id: 'minecraft:coal', name: 'Coal' } } } },
  }
  const result = await runTool([tool], {} as ToolContext, tool.name, { limit: '3', ignored: true })
  const data = result.data as { input: unknown; item: { name: string; en?: string } }
  assert.deepEqual(data.input, { limit: 3 })
  assert.equal(data.item.name, '煤')
  assert.equal(data.item.en, 'Coal')
})
