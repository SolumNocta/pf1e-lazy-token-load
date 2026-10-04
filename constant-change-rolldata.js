/**
 * Skip roll data for constant changes.
 *
 * PF1's ItemChange#applyChange starts with `rollData ??= parent.getRollData({ refresh: true })`, which deep-clones the
 * actor's system data. During data prep it is called for every change, and every "continuous" change is re-applied
 * after each one, so an actor with n changes (c continuous) pays ~n * (1 + c) full clones per preparation.
 *
 * applyChange only reads rollData when the formula is a real formula (`this.formula && isNaN(this.formula)`). For
 * empty or numeric formulas the clone is thrown away unused. This wrapper hands those calls an empty rollData so the
 * clone is skipped. Formulas still get a fresh clone every time, exactly as before.
 *
 * Registered as a libWrapper WRAPPER, so it runs in front of an OVERRIDE such as ckl-roll-bonuses' applyChange.
 */

const MODULE_ID = "pf1e-lazy-token-load";
const TARGET = "pf1.components.ItemChange.prototype.applyChange";
const NO_ROLL_DATA = Object.freeze({});
const stats = { skipped: 0, formula: 0 };

function skipRollDataForConstants(wrapped, actor, targets = null, options = {}) {
  if (options?.rollData === undefined && (!this.formula || !isNaN(this.formula))) {
    stats.skipped++;
    return wrapped(actor, targets, { ...options, rollData: NO_ROLL_DATA });
  }
  stats.formula++;
  return wrapped(actor, targets, options);
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "skipConstantRollData", {
    name: "Skip roll data for constant changes",
    hint: "Don't clone actor roll data when applying a change whose formula is a plain number. Reload to apply.",
    scope: "client", config: true, type: Boolean, default: true, requiresReload: true,
  });
});

Hooks.once("i18nInit", () => {
  if (!game.settings.get(MODULE_ID, "skipConstantRollData")) return;
  if (typeof pf1?.components?.ItemChange?.prototype?.applyChange !== "function") {
    console.warn(`${MODULE_ID} | ItemChange#applyChange not found (PF1 changed?), constant-change patch not applied`);
    return;
  }
  if (globalThis.libWrapper) {
    libWrapper.register(MODULE_ID, TARGET, skipRollDataForConstants, "WRAPPER");
  } else {
    const proto = pf1.components.ItemChange.prototype;
    const original = proto.applyChange;
    proto.applyChange = function (...args) {
      return skipRollDataForConstants.call(this, original.bind(this), ...args);
    };
  }
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | constant changes: skipped roll data for ${stats.skipped} applyChange calls, `
    + `${stats.formula} calls had formulas`);
});
