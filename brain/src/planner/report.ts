import { isRecord } from '../util.ts'
import { portHandle } from './adapter.ts'
import type { FactoryProject, GoalAssessment, ReportContext, ReportSummary, ThroughputResult } from './model.ts'

const EPS = 1e-7
function meets(rule: string, actual: number | undefined, target: number): boolean {
  if (actual === undefined || !Number.isFinite(actual)) return false
  const tolerance = EPS * Math.max(1, Math.abs(target))
  return rule === 'at-most' ? actual <= target + tolerance : rule === 'exact' ? Math.abs(actual - target) <= tolerance : actual + tolerance >= target
}

/** Explains, but never replaces, the complete native English books/diagnostics. */
export function summarizeReport(project: FactoryProject, nativeReport: unknown, context: ReportContext = {}): ReportSummary {
  const summary: ReportSummary = {
    status: 'failed', nativeReport, goals: [], machines: [], externalInputs: [], externalOutputs: [], forcedFlows: [], shortfalls: [],
    issues: [...context.issues ?? []], staticAnalysis: true,
    assumptions: [
      'Static steady-state arithmetic only: solved does not mean inventory is available or the world build can operate.',
      'Rates are items/s and mB/s (GT L = mB); durationTicks uses 20 ticks/s; power is EU/t. View rate units do not change solver inputs.',
      'Machine settings/defaults describe a model, not machines, coils, hatches, voltage or installed supply observed in the world.',
      'External imports, terminal inputs and forced inflows require actual sustained supply. Exports/forced outflows require disposal or storage capacity.',
      'Build quantities round total shared-machine time upward once per card; extraRecipes time-share one machine group. Production groups scope resource pools, not shared physical machines.',
      'A source with no explicit targetMode uses the native Exactly rule. To limit supply without requiring all of it, set targetMode: at-most.',
      'Machine formation, stock, startup materials, power distribution, piping, throughput bottlenecks and permissions still need world inspection and execution acceptance.',
    ],
  }
  if (!isRecord(nativeReport) || !isRecord(nativeReport.nodes) || !isRecord(nativeReport.storages) || !isRecord(nativeReport.edges) || !isRecord(nativeReport.resources) || typeof nativeReport.totalEuT !== 'number' || !Number.isFinite(nativeReport.totalEuT)) {
    summary.issues.push({ severity: 'error', code: 'INVALID_NATIVE_REPORT', message: 'Engine did not return a valid finite ThroughputResult.' })
    return summary
  }
  const report = nativeReport as unknown as ThroughputResult
  const plan = report.plan
  summary.totalEuT = report.totalEuT
  summary.forcedFlows = [...plan?.forced ?? []]
  summary.shortfalls = [...plan?.shortfalls ?? []]
  for (const forced of plan?.forced ?? []) if (forced.side === 'in' && forced.perSecond > EPS) summary.issues.push({
    severity: 'warning', code: 'FORCED_IMPORT', nodeId: forced.nodeId,
    message: `The native solve adds ${forced.perSecond}/s of ${forced.resourceKey} at ${forced.portKey}. Targets may be met only with this extra supply, beyond the drawn supply chain; a satisfied source cap does not close this gap.`,
  })
  summary.externalInputs = [
    ...(report.externalInputs ?? []).map(row => ({ source: 'native-externalInputs', ...row })),
    ...(plan?.forced ?? []).filter(row => row.side === 'in' && row.perSecond > EPS).map(row => ({ source: 'forced', ...row })),
    ...(plan?.terminals ?? []).filter(row => row.side === 'in' && row.perSecond > EPS).map(row => ({ source: 'terminal', ...row })),
  ]
  summary.externalOutputs = [
    ...(report.unconsumedOutputs ?? []).map(row => ({ source: 'native-unconsumedOutputs', ...row })),
    ...(plan?.forced ?? []).filter(row => row.side === 'out' && row.perSecond > EPS).map(row => ({ source: 'forced', ...row })),
    ...(plan?.terminals ?? []).filter(row => row.side === 'out' && row.perSecond > EPS).map(row => ({ source: 'terminal', ...row })),
    ...(plan?.spills ?? []).map(row => ({ source: 'buffer-spill', ...row })),
  ]
  summary.assumptions.push('Boundary lists preserve native resource balances and port-level detail as separate views of the same flows; do not sum both views together.')
  const unmet = new Set(plan?.unmetDrawers ?? [])
  for (const storage of project.storages ?? []) {
    const outgoing = project.edges.some(edge => edge.source === storage.id)
    const incoming = project.edges.some(edge => edge.target === storage.id)
    const rate = storage.targetPerSecond
    const source = project.poolMode
      ? (rate ?? 0) < 0 || storage.poolSide === 'source' || !storage.poolSide && outgoing && !incoming
      : outgoing && !incoming || !outgoing && !incoming && ((rate ?? 0) < 0 || storage.poolSide === 'source')
    const buffer = !project.poolMode && outgoing && incoming
    const reading = report.storages[storage.id]
    const actual = reading ? source ? reading.consumedPerSecond : reading.producedPerSecond : undefined
    const rule = storage.targetMode ?? (storage.poolTargetMode === 'ignore' ? 'ignore' : (rate ?? 0) < 0 || source ? 'exact' : storage.poolTargetMode ?? 'at-least')
    if (source && actual !== undefined && actual > EPS) summary.externalInputs.push({ source: 'source-storage', storageId: storage.id, resourceKey: `${storage.kind}:${storage.resourceId}`, perSecond: actual, rule, ...(rate !== undefined ? { limit: Math.abs(rate) } : {}) })
    if (buffer || !source && (storage.drainMode === 'byproduct' || storage.drainMode === 'trash') || rate === undefined || rule === 'ignore') continue
    const goal: GoalAssessment = { ownerId: storage.id, rule, target: Math.abs(rate), actual, resourceKey: `${storage.kind}:${storage.resourceId}`,
      met: !unmet.has(storage.id) && !reading?.targetUnreachable && meets(rule, actual, Math.abs(rate)) }
    summary.goals.push(goal)
  }
  for (const node of project.nodes) {
    const sectionIds = [node.id, ...(node.extraRecipes ?? []).map((_, index) => `${node.id}#r${index + 1}`)]
    const readings = sectionIds.flatMap(id => report.nodes[id] ? [report.nodes[id]] : [])
    const fractionalMachines = readings.reduce((sum, row) => sum + Math.max(0, row.theoreticalMachinesRequired), 0)
    const capacity = node.solvePin
    summary.machines.push({ nodeId: node.id, sections: sectionIds, fractionalMachines,
      buildMachines: Math.ceil(Math.max(0, fractionalMachines - EPS)), shared: sectionIds.length > 1,
      ...(capacity !== undefined ? { capacity } : {}), capacityExceeded: capacity !== undefined && fractionalMachines > capacity + EPS * Math.max(1, capacity),
      euT: readings.reduce((sum, row) => sum + (row.utilization > 0 ? row.euT : 0), 0),
    })
    for (const [handle, target] of Object.entries(node.portRates ?? {})) {
      const match = /^r(\d+):(.*)$/.exec(handle)
      const section = match ? Number(match[1]) : 0
      const bare = match?.[2] ?? handle
      const row = report.nodes[section ? `${node.id}#r${section}` : node.id]
      const flows = row ? bare.startsWith('input:') ? row.inputs : row.outputs : undefined
      const flow = flows && Object.values(flows).find(flow => portHandle(bare.startsWith('input:') ? 'input' : 'output', flow.kind, flow.resourceId) === bare)
      const actual = row && row.utilization <= 0 ? 0 : flow?.amountPerSecond
      summary.goals.push({ ownerId: `${node.id}:${handle}`, rule: 'exact', target, actual, met: meets('exact', actual, target), resourceKey: flow?.key })
    }
    // Old Solve/Build projects use this field; plan mode ignores it (adapter warns).
    if (node.targetOutput && !project.planMode) {
      const target = node.targetOutput
      const row = report.nodes[node.id]
      const key = `${target.kind}:${target.resourceId}` as const
      const actual = row?.utilization === 0 ? 0 : row?.outputs[key]?.amountPerSecond
      summary.goals.push({ ownerId: node.id, rule: 'at-least', target: target.amountPerSecond, actual, met: meets('at-least', actual, target.amountPerSecond), resourceKey: key })
    }
  }
  if (project.targetRate) {
    const target = project.targetRate
    const key = `${target.kind}:${target.resourceId}` as const
    const actual = report.resources[key]?.productPerSecond
    summary.goals.push({ ownerId: project.id, rule: 'at-least', target: target.amountPerSecond, actual, met: meets('at-least', actual, target.amountPerSecond), resourceKey: key })
  }
  if (project.recipes.some(r => r.outputs.some(o => (o.chance ?? 1) < 1))) summary.assumptions.push('Probabilistic outputs are expected long-run rates. Integer machine rounding does not guarantee completion of a finite batch or eliminate variance.')
  if (project.recipes.some(r => r.inputs.some(i => i.consumed === false || i.amount === 0))) summary.assumptions.push('Nonconsumed count-zero circuits, molds and catalysts are preparation conditions, not continuous consumption. Install the required item/settings before starting.')
  if (context.provenance?.some(p => p.status !== 'local-current')) summary.assumptions.push('Some recipes are declared/unverified or explicitly stale saved snapshots; these are assumptions, not a match with current local packdata.')
  for (const bottleneck of report.bottlenecks ?? []) summary.issues.push({ severity: 'warning', code: 'NATIVE_BOTTLENECK', message: bottleneck.message, nodeId: bottleneck.nodeId })
  for (const node of Object.values(report.nodes)) for (const warning of node.warnings ?? []) summary.issues.push({ severity: 'warning', code: 'NATIVE_MACHINE_WARNING', message: warning, nodeId: node.nodeId })
  if (plan?.alternativesComplete === false) summary.issues.push({ severity: 'warning', code: 'INCOMPLETE_ALTERNATIVES', message: 'Native alternatives search stopped early; the displayed alternative choices are incomplete.' })
  if (plan?.notes.some(note => note.message === 'PIN_DROPPED')) summary.issues.push({ severity: 'warning', code: 'PIN_DROPPED', message: 'Native solver dropped a pin. Inspect the unchanged plan.notes and target/capacity readouts before accepting this result.' })
  const failure = plan?.failure?.message
  if (summary.issues.some(issue => issue.severity === 'error')) summary.status = 'invalid'
  else if (report.stale) summary.status = 'failed'
  else if (failure === 'NO_PIN' || (plan?.unanchored.length ?? 0) > 0) summary.status = 'unanchored'
  else if (failure) summary.status = failure === 'SOLVER_UNSATISFIABLE' || failure === 'BALANCE_FAILED' || failure === 'PIN_CONFLICT' ? 'infeasible' : 'failed'
  else if (summary.goals.some(goal => !goal.met) || unmet.size || summary.shortfalls.length || summary.machines.some(m => m.capacityExceeded) || Object.values(report.nodes).some(n => n.powerStalled || n.status === 'missing-recipe')) summary.status = 'unmet'
  else if (summary.externalInputs.length) summary.status = 'needs-external-supply'
  else summary.status = 'satisfied'
  return summary
}
