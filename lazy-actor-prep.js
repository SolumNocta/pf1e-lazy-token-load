/**
 * Lazy world-actor preparation.
 *
 * At the end of Game#initializeDocuments Foundry calls _safePrepareData() on EVERY world document. For PF1 that is
 * ~40ms per actor (each Change deep-clones the actor's roll data), and it runs for every actor in the world whether
 * or not this client can see it.
 *
 * During that pass we skip preparation for actors this user can't see. Instead, the `system` property of the actor and
 * of each of its embedded items becomes a one-shot accessor: the first read of any of them removes all the accessors
 * and prepares the actor, so callers always see prepared data. (`items`/`effects` are non-configurable, so the
 * embedded items' `system` stands in for them.) After `ready`, any actor still deferred is prepared in the
 * background, one per idle callback.
 *
 * Hook order (Foundry v13): init -> i18nInit -> initializeDocuments() -> setup -> canvasInit -> ready
 */

const MODULE_ID = "pf1e-lazy-token-load";
const LAZY = Symbol(MODULE_ID);

let inDocumentInit = false;
const deferred = new Set();
const stats = { deferred: 0, onDemand: 0, background: 0 };

/** Put back the plain `system` data properties on the actor and its items. */
function restore(actor) {
  const saved = actor[LAZY];
  if (!saved) return false;
  delete actor[LAZY];
  deferred.delete(actor);
  for (const [target, value] of saved) {
    Object.defineProperty(target, "system", { value, writable: true, enumerable: true, configurable: true });
  }
  return true;
}

/** Restore and prepare a deferred actor. Returns true if work was done. */
function prepareNow(actor) {
  if (!restore(actor)) return false;
  actor._safePrepareData();
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
stats.rawReads = 0;

function rawReadAllowed(system) {
  const readers = RAW_READERS.filter((r) => r.accepts(system));
  if (!readers.length) return false;
  const stack = new Error().stack ?? "";
  return readers.some((r) => stack.includes(r.stack));
}

/** Turn `system` on the actor and its items into accessors that prepare the actor on first touch. */
function makeLazy(actor) {
  const targets = [actor, ...actor.items];
  const saved = new Map();
  for (const target of targets) {
    const d = Object.getOwnPropertyDescriptor(target, "system");
    if (!d || !d.configurable || !("value" in d)) return false;
    saved.set(target, d.value);
  }
  Object.defineProperty(actor, LAZY, { value: saved, writable: true, configurable: true });
  for (const target of targets) {
    Object.defineProperty(target, "system", {
      configurable: true,
      enumerable: true,
      get() {
        if (this === actor && rawReadAllowed(saved.get(actor))) {
          stats.rawReads++;
          return saved.get(actor);
        }
        if (prepareNow(actor)) stats.onDemand++;
        return this.system;
      },
      // Something is re-initializing the document (e.g. reset on a socket update), which re-prepares it afterwards.
      set(value) {
        restore(actor);
        this.system = value;
      },
    });
  }
  deferred.add(actor);
  stats.deferred++;
  return true;
}

function shouldDefer(actor) {
  if (!inDocumentInit || actor.isToken) return false;
  const user = game.user;
  if (!user) return false;
  if (user.isGM) return game.settings.get(MODULE_ID, "lazyActorsGM") && !actor.hasPlayerOwner;
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
    scope: "client", config: true, type: Boolean, default: false, requiresReload: true,
  });
});

Hooks.once("i18nInit", () => {
  if (!game.settings.get(MODULE_ID, "lazyActors")) return;
  // CONFIG.Actor.documentClass is a Proxy in PF1; patch the base class every actor type inherits from.
  const proto = foundry.documents.Actor.prototype;
  const original = proto._safePrepareData;
  proto._safePrepareData = function (...args) {
    if (shouldDefer(this) && makeLazy(this)) return;
    return original.apply(this, args);
  };
  inDocumentInit = true;
});

Hooks.once("setup", () => {
  inDocumentInit = false;
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | deferred ${stats.deferred} actors, ${stats.onDemand} prepared on demand before ready, `
    + `${stats.rawReads} raw reads`);
  const t0 = performance.now();
  const schedule = globalThis.requestIdleCallback ?? ((cb) => setTimeout(() => cb({ timeRemaining: () => 10 }), 50));
  const drain = (deadline) => {
    do {
      const actor = deferred.values().next().value;
      if (!actor) {
        console.log(`${MODULE_ID} | background prep done: ${stats.background} actors in background, `
          + `${stats.onDemand} on demand, ${Math.round(performance.now() - t0)}ms wall`);
        return;
      }
      if (prepareNow(actor)) stats.background++;
    } while (deadline.timeRemaining() > 5);
    schedule(drain, { timeout: 1000 });
  };
  schedule(drain, { timeout: 1000 });
});
