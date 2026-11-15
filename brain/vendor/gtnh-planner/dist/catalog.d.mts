import type {
  FactoryNode, MachineConfigControl, MachineConfigTierOption, MachineHandler,
  Recipe, RecipeOutput, ResourceAmount, ResourceKey, ResourceKind, VoltageTier,
} from '../types/model.js';
import type { MachineBehaviour } from '../types/machine-behaviour.js';
export type { MachineBehaviour } from '../types/machine-behaviour.js';
export * from '../types/model.js';

export interface MachineConfigTierControl {
  id: string;
  label: string;
  numeric?: MachineConfigControl['numeric'];
  minimum: MachineConfigTierOption;
  current: MachineConfigTierOption;
  tiers: MachineConfigTierOption[];
  minimumIndex: number;
  resource: MachineConfigTierOption['resource'];
}
export function getMachineTableControls(machineType: string | undefined, recipe?: Partial<Recipe>): MachineConfigControl[];
export function getMachineBehaviour(machineType: string | undefined): MachineBehaviour | undefined;
export function getMachineHiddenControlIds(machineType: string | undefined): string[];
export function machineTableNames(): string[];
export function machineTableSeedsFromBase(machineType: string | undefined): boolean;
export function normalizeMachineName(name: string): string;
export function getRecipeMachineHandlers(recipe: Pick<Recipe, 'machineType' | 'minimumTier' | 'source' | 'machineHandlers'> & Partial<Recipe>): MachineHandler[];
export function getSelectedMachineHandler(recipe: Pick<Recipe, 'machineType' | 'minimumTier' | 'source' | 'machineHandlers'> & Partial<Recipe>, node: Pick<FactoryNode, 'machineHandlerId'>): MachineHandler;
export function getRecipeMachineConfigTierControls(recipe: Pick<Recipe, 'machineType' | 'source' | 'nei' | 'machineConfigControls'>, node: Pick<FactoryNode, 'machineConfigTiers'>): MachineConfigTierControl[];
export function getRecipeCoilTierControl(recipe: Pick<Recipe, 'machineType' | 'source' | 'nei' | 'machineConfigControls'>, node: { coilTier?: string }): MachineConfigTierControl | undefined;
export function applyMachineHandlerToRecipe(recipe: Recipe, node: Pick<FactoryNode, 'machineHandlerId'>): Recipe;
export function recipeMapName(recipe: Pick<Recipe, 'machineType' | 'source'>): string;
export function makeResourceKey(kind: ResourceKind, resourceId: string): ResourceKey;
export function getResourceKey(resource: Pick<ResourceAmount, 'kind' | 'id'>): ResourceKey;
export function getChanceMultiplier(recipe: Pick<Recipe, 'metadata'>, output: RecipeOutput): number;
export function isRecipeInputConsumed(input: Pick<ResourceAmount, 'id'> & { kind?: string; consumed?: boolean }): boolean;
export function resourceMatchesInput(output: Pick<ResourceAmount, 'kind' | 'id' | 'displayName'>, input: Pick<ResourceAmount, 'kind' | 'id' | 'displayName' | 'alternatives'>): boolean;
export function makeResourceHandleId(side: 'input' | 'output', resource: Pick<ResourceAmount, 'kind' | 'id'>, slotIndex?: number): string;
export function parseResourceHandleId(handleId?: string | null): { side: 'input' | 'output'; kind: ResourceKind; resourceId: string; section: number } | undefined;
export function canonicalizeResourceHandleId(handleId?: string | null): string | undefined;
export function sectionHandleId(section: number, handleId: string): string;
export function splitSectionHandleId(handleId: string | undefined): { section: number; handleId: string | undefined };
export function sectionNodeId(nodeId: string, section: number): string;
export function parseSectionNodeId(id: string): { nodeId: string; section: number };
export function makePortKey(nodeId: string, side: 'i' | 'o', canonicalHandle: string): string;
export function parsePortKey(key: string): { nodeId: string; side: 'i' | 'o'; handle: string } | undefined;
export function getOverclockedRecipeStats(recipe: Recipe, node: FactoryNode): {
  durationTicks: number; eut: number; tier: VoltageTier; minimumTier: VoltageTier;
  overclockSteps: number; perfectOverclockSteps: number; perfectSpeedFactor: number; perfectEuFactor: number;
};
export function getMachineParallelMultiplier(recipe: Recipe, node: FactoryNode): number;
export function getMachineOutputMultiplier(recipe: Recipe, node: FactoryNode, output: RecipeOutput, tier: VoltageTier): number;
