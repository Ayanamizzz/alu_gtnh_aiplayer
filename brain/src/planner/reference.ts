import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { PLANNER_ENGINE_SOURCE } from './engine.ts'
import { plannerPage, PlannerStoreError } from './store.ts'

export const NATIVE_REFERENCES = ['project', 'solver'] as const
export type NativeReference = (typeof NATIVE_REFERENCES)[number]

/** A fixed, read-only documentation allowlist, not a caller-selected filesystem path. */
export function readPlannerReference(name: NativeReference = 'project', options: { query?: string; offset?: number; limit?: number } = {}) {
  if (!NATIVE_REFERENCES.includes(name)) throw new PlannerStoreError('invalid_reference', 'reference must be project or solver, not a path.')
  if (options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 200)) throw new PlannerStoreError('invalid_query', 'query must be at most 200 characters of literal text.')
  const file = name === 'project' ? 'model.ts' : 'native-plan-types.ts'
  const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
  const lines = text.split(/\r?\n/).map((text, index) => ({ line: index + 1, text }))
  const query = options.query?.toLowerCase()
  const matched = query ? lines.filter(row => row.text.toLowerCase().includes(query)) : lines
  return {
    reference: name,
    source: { ...PLANNER_ENGINE_SOURCE, file: `src/planner/${file}`, contentSha256: createHash('sha256').update(text).digest('hex') },
    note: 'Original English TypeScript contracts and comments, with local integration types clearly named. Documentation only, not JavaScript to execute. Line numbers are one-based; offset pages zero-based matching rows (all lines when query is omitted). Use query to find a type/field, then omit query and use offset=line-1 to read its surrounding definition.',
    totalLines: lines.length,
    ...(options.query !== undefined ? { query: options.query } : {}),
    ...plannerPage(matched, { offset: options.offset, limit: options.limit ?? 80 }),
  }
}
