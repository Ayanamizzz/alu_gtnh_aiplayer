import { STRUCTURAL_LIMITS } from './limits.mjs';

const list = (value) => Array.isArray(value) ? value : [];
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const keys = (value) => Object.keys(record(value)).length;
function check(kind, count) {
  if (count <= STRUCTURAL_LIMITS[kind]) return;
  const error = new Error(`Planner ${kind} budget exceeded: ${count} > ${STRUCTURAL_LIMITS[kind]}. Split the project into smaller analyses.`);
  error.name = 'PlannerLimitError';
  throw error;
}

/** Cheap structural policy only; call on a bounded plain-JSON snapshot, before data adaptation or solver allocation. */
export function assertPlannerStructure(value, operation = 'calculate') {
  const input = record(value);
  if (operation === 'solve') {
    const machines = list(input.machines).map(record);
    const edges = list(input.edges);
    const pools = list(input.pools).map(record);
    const drawers = list(input.drawers).map(record);
    check('nodes', machines.length); check('edges', edges.length); check('storages', drawers.length);
    check('ports', machines.reduce((sum, machine) => sum + list(machine.inputs).length + list(machine.outputs).length, 0));
    check('constraints', pools.length + drawers.length + keys(input.extentPins)
      + machines.reduce((sum, machine) => sum + keys(machine.targetInputRates) + keys(machine.targetOutputRates) + (machine.countFixed ? 1 : 0), 0));
    check('links', edges.length * 2 + pools.reduce((sum, pool) => sum + list(pool.machines).length, 0)
      + drawers.reduce((sum, drawer) => sum + list(drawer.links).length + list(drawer.takers).length, 0));
    return;
  }
  const recipes = new Map(list(input.recipes).map((entry) => { const recipe = record(entry); return [recipe.id, recipe]; }));
  const nodes = list(input.nodes).map(record);
  check('nodes', nodes.length); check('edges', list(input.edges).length);
  const storages = list(input.storages).map(record);
  check('storages', storages.length);
  let sections = 0;
  let ports = 0;
  let constraints = 0;
  // A runtime ladder may be large and shared by many nodes. Inspect it once,
  // keeping preflight linear in the supplied JSON rather than nodes x variants.
  const portCounts = new Map();
  for (const node of nodes) {
    const recipeIds = [node.recipeId, ...list(node.extraRecipes).map((entry) => record(entry).recipeId)];
    sections += recipeIds.length;
    check('nodes', sections);
    constraints += keys(node.portRates) + (node.solvePin === undefined ? 0 : 1) + (node.targetOutput ? 1 : 0);
    for (const recipeId of recipeIds) {
      if (!portCounts.has(recipeId)) {
        const recipe = recipes.get(recipeId);
        let count = 0;
        if (recipe) {
          let outputs = list(recipe.outputs).length;
          for (const variant of list(record(recipe.runtimeCalculation).variants)) outputs = Math.max(outputs, list(record(variant).outputs).length);
          count = list(recipe.inputs).length + outputs;
        }
        portCounts.set(recipeId, count);
      }
      ports += portCounts.get(recipeId);
      check('ports', ports);
    }
  }
  constraints += storages.filter((storage) => storage.targetPerSecond !== undefined).length + (input.targetRate ? 1 : 0);
  check('constraints', constraints);
  check('links', list(input.edges).length * 2 + Object.values(record(input.spareShares)).reduce((sum, shares) => sum + keys(shares), 0));
}
