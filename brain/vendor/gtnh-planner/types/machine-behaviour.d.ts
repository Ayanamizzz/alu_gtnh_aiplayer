import type { MachineConfigControl, Recipe } from "./model.js";
export interface OverclockRule {
  maxPerfect: number;
  maxNormal: number;
  /** Speed factor of a perfect step: what duration is divided by. */
  multiplier: number;
  /**
   * EU/t factor of a perfect step when it differs from the speed factor
   * (default `multiplier`). The game's `OverclockCalculator` always charges
   * `eutIncreasePerOC` (4 for every non-fusion machine), so an arc furnace
   * electrode with a speed factor of 2 still pays 4x per step.
   */
  euMultiplier?: number;
}

export declare const HEAT_OVERCLOCK: "heat";
export type OverclockSpec = OverclockRule | typeof HEAT_OVERCLOCK;

export interface MachineContext {
  /**
   * Zero-based index of the selected tier for one of our machine config
   * controls, e.g. `tier("heatingCoil")` is 0 for cupronickel and 3 for TPV.
   * Returns 0 when the recipe carries no such control.
   */
  tier: (controlId: string) => number;
  /**
   * The numeric value behind a count knob, e.g. `value("plasmaMixerParallels")`
   * is 256, not the position of 256 in the list. The reference states some
   * choices as raw counts with a minimum rather than as a tier ladder, and
   * their formulas read the count, so those must not use `tier`.
   */
  value: (controlId: string) => number;
  /**
   * Voltage tier ordinal of the tier the machine runs at, counting ULV as 0
   * and LV as 1. Equals the reference's `voltageTier + 1`.
   */
  voltageTier: number;
  /**
   * Voltage tier ordinal of the recipe's own EU/t draw, for the machines whose
   * discounts compare against the recipe rather than the hatch (the Mega Alloy
   * Blast Smelter). Optional because test harnesses omit it.
   */
  recipeVoltageTier?: number;
  /**
   * The recipe's special value, for the machines whose coefficients read it as
   * something other than heat (the Naquadah Fuel Refinery's minimum field
   * restriction coil tier). Optional because test harnesses omit it, so a
   * formula must state its own default.
   */
  recipeSpecialValue?: number;
  /** Original recipe map, retained when a handler replaces the machine name. */
  recipeMap?: string;
  /** The recipe itself, for machines whose rules read more than its numbers (the Bacterial Vat's glass). */
  recipe?: Partial<Recipe>;
  /** The node's raw settings, by control id. */
  settings?: Record<string, string>;
}

type Coefficient = number | ((ctx: MachineContext) => number);

export interface MachineBehaviour {
  /** A source-verified machine-specific whole/sub-tick rounding rule. */
  quantiseDuration?: (durationTicks: number) => number;
  /**
   * The machine's own fixed cycle in ticks. It never reads the recipe's
   * duration, so the recipe's amounts are per cycle and this replaces the
   * duration the recipe or any handler states (`applyMachineHandlerToRecipe`).
   */
  cycleTicks?: number;
  /** Throughput multiplier: 2 means the recipe finishes in half the time. */
  speed?: Coefficient;
  /** EU/t multiplier applied before parallels. */
  power?: Coefficient;
  /** Parallels the structure offers, before the voltage has to pay for them. */
  parallels?: Coefficient;
  overclock: OverclockSpec | ((ctx: MachineContext) => OverclockSpec);
  /**
   * Marks a singleblock family. The table is otherwise multiblocks only, and
   * two things hang on the difference: a singleblock's overclocks are capped
   * by voltage tier as well as by power, and it cannot bank sub-tick speed as
   * parallels - it sits at the one-tick floor.
   */
  kind?: "single";
  /**
   * Amps the machine works with, giving it `tier voltage x amperage` EU/t to
   * count overclocks against. The arc furnaces are registered at 3A alongside
   * their 300% power usage, which is how a 90 EU/t draw still runs on an LV
   * machine.
   */
  amperage?: number;
  /**
   * Mega-style power (`MegaMultiBlockBase.setProcessingLogicPower`): the pool
   * is `getMaxInputEu()`, the SUM of every hatch's full rating - so even a
   * lone regular hatch contributes its whole 2 amps, with no single-hatch
   * clamp.
   */
  fullPowerPool?: boolean;
  /** `setUnlimitedTierSkips`: a recipe above the hatch tier still starts. */
  unlimitedTierSkip?: boolean;
  /**
   * How a HEAT_OVERCLOCK machine computes its machine heat, transcribed from
   * each machine's `setMachineHeat` call. See `heat.ts`.
   */
  heat?: {
    /** +100 K per voltage tier above MV (the blast furnaces and the Hearth). */
    voltageBonus?: boolean;
    /** Coil heat is counted this many times over (Zyngen: 2). */
    coilHeatMultiplier?: number;
    /** The 5% EU discount per 900 K of excess; default on, Zyngen opts out. */
    discount?: boolean;
  };
  /**
   * Knobs this machine offers that the dataset has no control for. Emitted in
   * the dataset's own control shape so the existing config UI renders them
   * with no changes, and merged over any control of the same id.
   */
  controls?: MachineConfigControl[];
  /**
   * Knobs that depend on the recipe (a tree's tool per output it has, radiation only where a vat recipe needs
   * it). Used instead of `controls` when a recipe is at hand.
   */
  controlsFor?: (recipe: Partial<Recipe>) => MachineConfigControl[];
  /** Resolve legacy choices before both the UI and the solver read controls. */
  normalizeConfig?: (settings: Record<string, string>) => Record<string, string>;
  /** Structural recipe gate independent of how much power the hatches supply. */
  recipeGate?: (ctx: MachineContext) => string | undefined;
  /** Structural cap on working voltage, before multiplying by supplied amps. */
  inputVoltageTierLimit?: (settings: Record<string, string>) => number;
  /** The controller's unlock tier is not a minimum energy-hatch voltage. */
  recipeTierFromBase?: boolean;
  /**
   * Dataset control ids to drop for this machine: knobs the scraper invented
   * that the machine does not have (e.g. the fluid pipe casing ladder on a
   * machine that takes item pipe casings).
   */
  hidesControls?: string[];
  /** Names this machine also goes by, including the reference's own name. */
  aliases?: string[];
  /** A known gap, carried over from the reference. */
  note?: string;
}

