/**
 * Lazy actor preparation.
 *
 * World actors: at the end of Game#initializeDocuments Foundry calls _safePrepareData() on EVERY world document. For
 * PF1 that is ~40ms per actor, including actors this client may never look at. During that pass we skip actors this
 * user can't see (as GM: actors with no player owner).
 *
 * Token actors: the synthetic actor of an unlinked token is built and prepared whenever anything reads `token.actor`.
 * Sequencer's GM-only ready migration, for example, reads it for every owned token in the world just to look at a
 * prototype token flag. Their preparation is deferred the same way, at any time.
 *
 * A deferred actor's prepared-data properties (system, statuses, changes, sourceInfo, changeFlags, changeOverrides)
 * and its items' (system, actions, changes) become one-shot accessors: the first read of any of them removes all the
 * accessors and prepares the actor, so callers always see prepared data. Only itemFlags and the internal _rollData
 * cache can't be trapped (they are non-configurable). After `ready`, deferred world actors are prepared in the
 * background; token actors are only prepared on demand.
 *
 * Hook order (Foundry v13): init -> i18nInit -> initializeDocuments() -> setup -> canvasInit -> ready
 */

const MODULE_ID = "pf1e-lazy-token-load";
const LAZY = Symbol(MODULE_ID);
const ACTOR_KEYS = ["system", "statuses", "changes", "sourceInfo", "changeFlags", "changeOverrides"];
const ITEM_KEYS = ["system", "actions", "changes"];

let inDocumentInit = false;
let originalSafePrepare = null;
const enabled = { worldActors: false, worldActorsGM: false, tokenActors: false };
const deferred = new Set(); // deferred world actors, worked through by the background pass
const stats = { deferred: 0, tokenDeferred: 0, onDemand: 0, background: 0, rawReads: 0 };

/** Put back the original properties on the actor and its items. */
function restore(actor) {
  const saved = actor[LAZY];
  if (!saved) return false;
  delete actor[LAZY];
  deferred.delete(actor);
  for (const { target, key, desc } of saved) {
    if (desc) Object.defineProperty(target, key, desc);
    else delete target[key];
  }
  return true;
}

/** Restore and prepare a deferred actor. Returns true if work was done. */
function prepareNow(actor) {
  if (!restore(actor)) return false;
  originalSafePrepare.call(actor); // the unpatched method, so the actor can't be deferred again
  return true;
}

/**
 * Readers that only need stored (unprepared) data, so a deferred actor can be served its raw `system` without
 * preparing it. Each entry matches the reader's call site in the stack and checks that raw data gives the same answer
 * prepared data would; otherwise the actor is prepared as usual.
 */
const RAW_READERS = [
  {
    // pf1-pow's GM-only ready migration (migrateOldActors) reads every actor's system.skills and adds kmt/ahp when
    // missing. Prep never removes stored skills, so when both are stored the answer is the same and nothing is written.
    stack: "/modules/pf1-pow/scripts/hooks/ready.mjs",
    accepts: (system) => system?.skills?.kmt !== undefined && system?.skills?.ahp !== undefined,
  },
];

function rawReadAllowed(system) {
  const readers = RAW_READERS.filter((r) => r.accepts(system));
  if (!readers.length) return false;
  const stack = new Error().stack ?? "";
  return readers.some((r) => stack.includes(r.stack));
}

/**
 * Actor class fields (`statuses = this.statuses ?? new Set()` in Foundry's Actor). They run right after the base
 * constructor, which is where a token actor is first prepared, so trapping them then would make the initializer read
 * the trap (preparing the actor) and then overwrite it. They are trapped after construction instead (trapLate).
 */
const CLASS_FIELD_KEYS = new Set(["statuses"]);

/** Replace `entries` with accessors that prepare `actor` on first read. */
function defineTraps(actor, entries) {
  const rawSystem = actor[LAZY][0].desc.value;
  for (const { target, key } of entries) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get() {
        if (target === actor && key === "system" && rawReadAllowed(rawSystem)) {
          stats.rawReads++;
          return rawSystem;
        }
        if (prepareNow(actor)) stats.onDemand++;
        return target[key];
      },
      // Something is re-initializing the document (e.g. reset on a socket update), which re-prepares it afterwards.
      set(value) {
        restore(actor);
        target[key] = value;
      },
    });
  }
}

/** Trap class fields that didn't exist yet when the actor was deferred during construction. */
function trapLate(actor) {
  const saved = actor?.[LAZY];
  if (!saved) return;
  const late = [];
  for (const key of CLASS_FIELD_KEYS) {
    if (saved.some((s) => s.target === actor && s.key === key)) continue;
    const desc = Object.getOwnPropertyDescriptor(actor, key);
    if (!desc?.configurable || !("value" in desc)) continue;
    late.push({ target: actor, key, desc });
  }
  saved.push(...late);
  defineTraps(actor, late);
}

/** Turn the prepared-data properties of the actor and its items into accessors that prepare the actor on first read. */
function makeLazy(actor) {
  const saved = [];
  const collect = (target, keys) => keys.every((key) => {
    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (!desc && target === actor && CLASS_FIELD_KEYS.has(key)) return true; // still constructing, see trapLate
    if (desc ? !desc.configurable || !("value" in desc) : key === "system") return false;
    saved.push({ target, key, desc });
    return true;
  });
  if (!collect(actor, ACTOR_KEYS)) return false;
  for (const item of actor.items) if (!collect(item, ITEM_KEYS)) return false;

  Object.defineProperty(actor, LAZY, { value: saved, writable: true, configurable: true });
  defineTraps(actor, saved);
  if (actor.isToken) stats.tokenDeferred++;
  else {
    deferred.add(actor);
    stats.deferred++;
  }
  return true;
}

function shouldDefer(actor) {
  if (actor.isToken) return enabled.tokenActors;
  if (!inDocumentInit || !enabled.worldActors) return false;
  const user = game.user;
  if (!user) return false;
  if (user.isGM) return enabled.worldActorsGM && !actor.hasPlayerOwner;
  return !actor.testUserPermission(user, "LIMITED");
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "lazyActors", {
    name: "Lazy actor preparation",
    hint: "Defer preparing world actors you can't see until something uses them. Reload to apply.",
    scope: "client", config: true, type: Boolean, default: true, requiresReload: true,
  });
  game.settings.register(MODULE_ID, "lazyActorsGM", {
    name: "Lazy actor preparation for GM",
    hint: "As a GM, also defer actors that have no player owner. Reload to apply.",
    scope: "client", config: true, type: Boolean, default: true, requiresReload: true,
  });
  game.settings.register(MODULE_ID, "lazyTokenActors", {
    name: "Lazy token actor preparation",
    hint: "Defer preparing the actors of unlinked tokens until something reads their data. Modules that only touch a "
      + "token's actor (for example to read a flag) then don't pay for a full PF1 preparation. Reload to apply.",
    scope: "client", config: true, type: Boolean, default: true, requiresReload: true,
  });
  game.settings.register(MODULE_ID, "backgroundPrep", {
    name: "Background preparation of deferred actors",
    hint: "After load, deferred world actors are prepared in the background (actors in combat and on navigation "
      + "scenes first). Smooth: one actor at a time while the browser is idle and you aren't interacting. Fast: as "
      + "quickly as possible, which can stutter for a while after load. Off: only when something reads the actor's "
      + "data. Reload to apply.",
    scope: "client", config: true, type: String, default: "smooth", requiresReload: true,
    choices: { smooth: "Smooth", fast: "Fast", off: "Off" },
  });
});

Hooks.once("i18nInit", () => {
  enabled.worldActors = game.settings.get(MODULE_ID, "lazyActors");
  enabled.worldActorsGM = enabled.worldActors && game.settings.get(MODULE_ID, "lazyActorsGM");
  enabled.tokenActors = game.settings.get(MODULE_ID, "lazyTokenActors");
  if (!enabled.worldActors && !enabled.tokenActors) return;
  // CONFIG.Actor.documentClass is a Proxy in PF1; patch the base class every actor type inherits from.
  const proto = foundry.documents.Actor.prototype;
  originalSafePrepare = proto._safePrepareData;
  proto._safePrepareData = function (...args) {
    if (shouldDefer(this) && makeLazy(this)) return;
    return originalSafePrepare.apply(this, args);
  };
  if (enabled.tokenActors) {
    // Token actors are first prepared inside their constructor; trap the class fields once construction is done.
    const deltaProto = foundry.documents.ActorDelta.prototype;
    const originalCreate = deltaProto._createSyntheticActor;
    deltaProto._createSyntheticActor = function (...args) {
      const result = originalCreate.apply(this, args);
      trapLate(this.syntheticActor);
      return result;
    };
  }
  inDocumentInit = true;
});

Hooks.once("setup", () => {
  inDocumentInit = false;
});

/** Deferred actors in background order: combatants, then actors linked on the viewed and navigation scenes. */
function backgroundQueue() {
  const first = new Set();
  const add = (actor) => { if (actor && deferred.has(actor)) first.add(actor); };
  for (const combat of game.combats) {
    for (const combatant of combat.combatants) if (combatant.token?.actorLink ?? true) add(game.actors.get(combatant.actorId));
  }
  for (const scene of [canvas?.scene, ...game.scenes.filter((s) => s.navigation)]) {
    for (const token of scene?.tokens ?? []) if (token.actorLink) add(game.actors.get(token.actorId));
  }
  return [...first, ...[...deferred].filter((a) => !first.has(a))];
}

const INPUT_QUIET_MS = 750; // smooth mode waits this long after the last user input
const SMOOTH_GAP_MS = 50; // and leaves at least this much time between two actors

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | deferred ${stats.deferred} actors and ${stats.tokenDeferred} token actors, `
    + `${stats.onDemand} prepared on demand before ready, ${stats.rawReads} raw reads`);
  const mode = game.settings.get(MODULE_ID, "backgroundPrep");
  if (mode === "off" || !deferred.size) return;

  const queue = backgroundQueue();
  const t0 = performance.now();
  const next = () => {
    while (queue.length) {
      const actor = queue.shift();
      if (deferred.has(actor)) return actor;
    }
    console.log(`${MODULE_ID} | background prep done (${mode}): ${stats.background} actors in background, `
      + `${stats.onDemand} on demand, ${Math.round(performance.now() - t0)}ms wall`);
    return null;
  };
  const idle = globalThis.requestIdleCallback ?? ((cb) => setTimeout(() => cb({ timeRemaining: () => 10, didTimeout: false }), 50));

  if (mode === "fast") {
    const drain = (deadline) => {
      do {
        const actor = next();
        if (!actor) return;
        if (prepareNow(actor)) stats.background++;
      } while (deadline.timeRemaining() > 5);
      idle(drain, { timeout: 1000 });
    };
    idle(drain, { timeout: 1000 });
    return;
  }

  // Smooth: one actor per idle period, never while the user is interacting.
  let lastInput = 0;
  const onInput = () => { lastInput = performance.now(); };
  const events = ["pointermove", "pointerdown", "wheel", "keydown"];
  for (const e of events) window.addEventListener(e, onInput, { capture: true, passive: true });
  const step = () => {
    const quietFor = performance.now() - lastInput;
    if (quietFor < INPUT_QUIET_MS) return void setTimeout(() => idle(step), INPUT_QUIET_MS - quietFor);
    const actor = next();
    if (!actor) {
      for (const e of events) window.removeEventListener(e, onInput, { capture: true });
      return;
    }
    if (prepareNow(actor)) stats.background++;
    setTimeout(() => idle(step), SMOOTH_GAP_MS);
  };
  idle(step);
});
