// Pure synchronous exports: no solver, HiGHS, browser, filesystem or initialization.
export {
  getMachineTableControls, getMachineBehaviour, machineTableNames,
  getMachineHiddenControlIds, normalizeMachineName, machineTableSeedsFromBase,
} from './upstream/src/lib/machines/machine-table';
export {
  getRecipeMachineHandlers, getSelectedMachineHandler, getRecipeMachineConfigTierControls,
  getRecipeCoilTierControl, applyMachineHandlerToRecipe, recipeMapName,
} from './upstream/src/lib/model/recipe-rules';
export {
  makeResourceKey, getResourceKey, getChanceMultiplier, isRecipeInputConsumed, resourceMatchesInput,
} from './upstream/src/lib/model/resources';
export { canonicalizeResourceHandleId } from './upstream/src/lib/model/edge-identity';
export { sectionHandleId, splitSectionHandleId, sectionNodeId, parseSectionNodeId } from './upstream/src/lib/model/shared-machine';
export { makePortKey, parsePortKey } from './upstream/src/lib/solver/plan/port-key';
export { makeResourceHandleId, parseResourceHandleId } from './upstream/src/components/flow/resource-handles';
export { PROJECT_SCHEMA_VERSION, TICKS_PER_SECOND } from './upstream/src/lib/model/types';
export { getOverclockedRecipeStats } from './upstream/src/lib/solver/overclock';
export { getMachineParallelMultiplier, getMachineOutputMultiplier } from './upstream/src/lib/solver/machine-effects';
