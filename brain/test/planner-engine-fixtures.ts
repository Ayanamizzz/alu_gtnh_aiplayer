import type {
  FactoryEdge, FactoryNode, FactoryProject, FactoryStorage, Recipe,
} from '../vendor/gtnh-planner/types/model.js';

export function recipe(id: string, inputs: [string, number][], outputs: [string, number][], extra: Partial<Recipe> = {}): Recipe {
  return {
    id, name: id, machineType: 'Assembler', minimumTier: 'LV', durationTicks: 20, eut: 8,
    inputs: inputs.map(([resourceId, amount]) => ({ kind: 'item', id: resourceId, amount })),
    outputs: outputs.map(([resourceId, amount]) => ({ kind: 'item', id: resourceId, amount })),
    ...extra,
  };
}
export function node(id: string, recipeId: string, extra: Partial<FactoryNode> = {}): FactoryNode {
  return { id, recipeId, machineCount: 1, parallel: 1, overclockTier: 'LV', enabled: true, position: { x: 0, y: 0 }, ...extra };
}
export function storage(id: string, resourceId: string, extra: Partial<FactoryStorage> = {}): FactoryStorage {
  return { id, kind: 'item', resourceId, position: { x: 0, y: 0 }, ...extra };
}
export function wire(id: string, source: string, target: string, resourceId: string, extra: Partial<FactoryEdge> = {}): FactoryEdge {
  return { id, source, target, resourceKind: 'item', resourceId, ...extra };
}
export function project(extra: Partial<FactoryProject> = {}): FactoryProject {
  return { schemaVersion: 1, id: 'factory', name: 'Factory', planMode: true, solveMode: true, recipes: [], nodes: [], storages: [], edges: [], fuelProfiles: [], ...extra };
}
export function chain(): FactoryProject {
  return project({
    recipes: [recipe('crush', [['ore', 1]], [['dust', 2]], { durationTicks: 40 }), recipe('press', [['dust', 1]], [['plate', 1]])],
    nodes: [node('crush', 'crush'), node('press', 'press')],
    storages: [storage('ore', 'ore'), storage('plate', 'plate', { targetPerSecond: 3, targetMode: 'exact' })],
    edges: [wire('in', 'ore', 'crush', 'ore'), wire('middle', 'crush', 'press', 'dust'), wire('out', 'press', 'plate', 'plate')],
  });
}
