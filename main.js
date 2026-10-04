/**
 * PF1's TokenDocumentPF#prepareBaseData calls _syncSenses(), whose first check is `this.actor`.
 * For an unlinked token that builds a full synthetic ActorPF (items, changes, roll data).
 * Foundry prepares the tokens of EVERY scene during Game#initializeDocuments, so every unlinked
 * token in the world gets a synthetic actor at load, even on scenes nobody is looking at.
 *
 * Fix: skip _syncSenses while documents are being initialized, then sync the tokens of whichever
 * scene the canvas draws (canvasInit runs before tokens and vision sources are drawn).
 * Hook order (Foundry v13): init -> i18nInit -> initializeDocuments() -> setup -> canvasInit -> ready
 */

const MODULE_ID = "pf1e-lazy-token-load";
let initializingDocuments = true;

Hooks.once("i18nInit", () => {
  const proto = CONFIG.Token.documentClass?.prototype;
  if (typeof proto?._syncSenses !== "function") {
    console.warn(`${MODULE_ID} | TokenDocument#_syncSenses not found (PF1 changed?), patch not applied`);
    initializingDocuments = false;
    return;
  }

  const skipWhileInitializing = function (wrapped, ...args) {
    if (initializingDocuments) return;
    return wrapped(...args);
  };

  if (globalThis.libWrapper) {
    libWrapper.register(MODULE_ID, "CONFIG.Token.documentClass.prototype._syncSenses", skipWhileInitializing, "MIXED");
  } else {
    const original = proto._syncSenses;
    proto._syncSenses = function (...args) {
      return skipWhileInitializing.call(this, original.bind(this), ...args);
    };
  }
});

Hooks.once("setup", () => {
  initializingDocuments = false;
});

Hooks.on("canvasInit", (canvas) => {
  for (const token of canvas.scene?.tokens ?? []) token._syncSenses();
});
