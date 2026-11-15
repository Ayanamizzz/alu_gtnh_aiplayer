import { STRUCTURAL_LIMITS } from './limits.mjs';
import { assertPlannerStructure } from './shape-budget.mjs';
import type { FactoryProject } from './upstream/src/lib/model/types';
import type { SolveInput } from './upstream/src/lib/solver/plan/types';
import type { LinearProgram } from './upstream/src/lib/solver/simplex';

let exceeded: string | undefined;
export function resetBudget(): void { exceeded = undefined; }
function fail(message: string): never {
  exceeded = message;
  const error = new Error(message);
  error.name = 'PlannerLimitError';
  throw error;
}
export function throwIfBudgetExceeded(): void { if (exceeded) fail(exceeded); }
function check(kind: keyof typeof STRUCTURAL_LIMITS, count: number): void {
  if (count > STRUCTURAL_LIMITS[kind]) fail(`Planner ${kind} budget exceeded: ${count} > ${STRUCTURAL_LIMITS[kind]}. Split the project into smaller analyses.`);
}

export function checkProjectBudget(project: FactoryProject): void { assertPlannerStructure(project, 'calculate'); }
export function checkSolveBudget(input: SolveInput): void { assertPlannerStructure(input, 'solve'); }

/** Runs before HiGHS can allocate a model, including models expanded by pool mode. */
export function assertLpBudget(lp: LinearProgram): void {
  const columns = lp.maximize.length;
  const rows = lp.equalities.length + lp.upperBounds.length;
  check('lpColumns', columns); check('lpRows', rows);
  check('lpDenseCells', columns * rows);
  let nonzeros = 0;
  for (const row of lp.equalities) nonzeros += row.coefficients.size;
  for (const row of lp.upperBounds) nonzeros += row.coefficients.size;
  check('lpNonzeros', nonzeros);
}

/** Dense simplex has extra slack/artificial columns; bound its actual tableau shape. */
export function assertSimplexBudget(lp: LinearProgram): void {
  const rows = 2 * lp.equalities.length + lp.upperBounds.length;
  check('simplexTableauCells', (rows + 2) * (lp.maximize.length + rows + 2));
}
