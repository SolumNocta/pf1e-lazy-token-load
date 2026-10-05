/**
 * PF1's TokenDocumentPF#prepareBaseData calls _syncSenses(), whose first check is `this.actor`.
 * For an unlinked token that builds a full synthetic ActorPF (items, changes, roll data).
 * Foundry prepares the tokens of EVERY scene during Game#initializeDocuments, so every unlinked
 * token in the world gets a synthetic actor at load, even on scenes nobody is looking at.
 *
 * Fix: skip _syncSenses while documents are being initialized, then sync the tokens of whichever
 * scene the canvas draws, before its tokens and vision sources are drawn.
 *
 * Canvas#draw runs: canvasInit hooks -> load scene textures (network) -> canvasDraw hook -> draw tokens.
 * Syncing inside canvasInit would block texture loading behind seconds of actor building, so canvasInit
 * only queues the tokens and works through them in small slices while the textures download; canvasDraw
 * finishes whatever is left before any token is drawn.
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

const SLICE_MS = 20;

/**
 * Prepare a token's actor (reading `system` triggers lazy preparation, see lazy-actor-prep.js) and sync its senses.
 * The explicit read matters because _syncSenses returns early (custom vision rules, system vision off) without
 * touching the actor, and the token is about to be drawn.
 */
function prepareToken(token) {
  token.actor?.system;
  token._syncSenses();
}
let pending = null;

function syncSlice(queue) {
  if (pending !== queue) return; // a newer canvas draw took over, or canvasDraw already finished the queue
  const end = performance.now() + SLICE_MS;
  while (queue.length && performance.now() < end) prepareToken(queue.pop());
  if (queue.length) setTimeout(syncSlice, 0, queue);
  else pending = null;
}

Hooks.on("canvasInit", (canvas) => {
  pending = [...(canvas.scene?.tokens ?? [])];
  setTimeout(syncSlice, 0, pending);
});

Hooks.on("canvasDraw", () => {
  const queue = pending;
  pending = null;
  while (queue?.length) prepareToken(queue.pop());
});
