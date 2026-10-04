# PF1e Lazy Token Load

Foundry VTT v13 + Pathfinder 1e module that cuts world load time on worlds with many unlinked tokens.

PF1's `TokenDocumentPF#prepareBaseData` calls `_syncSenses()`, which accesses `this.actor` first. For unlinked tokens this builds a full synthetic actor, and Foundry prepares the tokens of every scene during load. This module skips that sync while world documents are initializing and instead syncs the tokens of each scene as it is drawn (`canvasInit`).

Manifest URL:

```
https://github.com/SolumNocta/pf1e-lazy-token-load/releases/latest/download/module.json
```

## Lazy actor preparation

At the end of world load Foundry prepares every world actor. For PF1 that costs roughly 40ms per actor, and it runs even for actors the current user cannot see. With this option on, actors the user has no permission to view skip that pass. The `system` property of each such actor and of its embedded items becomes a one-shot accessor: the first read prepares the actor, so callers always see prepared data. After `ready`, anything still deferred is prepared in the background, one actor per idle callback.

Client settings (reload to apply):

- **Lazy actor preparation** (default on)
- **Lazy actor preparation for GM** (default on): as a GM, also defer actors with no player owner

Only reads of `system` trigger preparation. Code that reads other prepared actor fields (`changes`, `sourceInfo`, `itemFlags`) of an untouched actor before `system` sees them unprepared until background prep reaches that actor. Turn the options off if a module misbehaves.

The console logs how many actors were deferred and how many were prepared on demand before `ready`. A high on-demand count means some module reads every actor at startup, which cancels the benefit.

## Skip roll data for constant changes

PF1's `ItemChange#applyChange` deep-clones the actor's roll data on every call, and during data prep every "continuous" change is re-applied after each change. For changes whose formula is empty or a plain number the clone is never read. This wraps `applyChange` (a libWrapper `WRAPPER`, so it sits in front of overrides such as ckl-roll-bonuses') and passes an empty `rollData` for those calls. Formulas still get a fresh clone every time.

Client setting **Skip roll data for constant changes** (default on). On the benchmark world it skips ~17k of ~64k clones during load and saves about 1s of data prep for players and GMs alike; actor `system`, roll data, item data and change values were identical for all 524 actors.

## Benchmark

Local Foundry 13.351 + PF1 11.11 with lib-wrapper, ckl-roll-bonuses, pf1-pow and pf1-psionics, loading a copy of a live world (524 actors / 13,541 embedded items, 86 scenes / 896 unlinked tokens). Times are to `game.ready`; "prep" is Foundry's own "Prepared World Documents" figure.

| Configuration | Player prep | Player ready | GM ready |
|---|---|---|---|
| Module disabled | 30.4s | 37.6s | 37.6s |
| Token fix only | 14.8s | 23.3s | 22.9s |
| Token fix + lazy actors | 3.7s | 13.3s | 25.2s (GM option) |
| Token fix + constant-change skip | 13.9s | 21.2s | 22.5s |
| All three, GM option off | 3.7s | 13.2s | 22.1s |
| All three, GM option on (default) | 3.3s | 13.0s | 15.0s |

With lazy actors on, derived data (AC, CMD, HP, saves, abilities, skills, encumbrance, item state) was identical to a normal load for all 524 actors once background prep finished.

pf1-pow's GM-only `ready` migration reads `system.skills` on every actor. When both of its skills (`kmt`, `ahp`) are already stored, that read is served from stored data instead of preparing the actor, since preparation never removes stored skills and the migration reaches the same answer. Otherwise the actor is prepared as usual.

Known difference: pf1-psionics attaches its actor helper in its own `ready` hook, so actors prepared after `ready` cache roll data that includes `psionics.powerPoints`, while actors prepared during load do not. Lazily prepared actors are in the same state any actor reaches after its first update in a session.
