# PF1e Lazy Token Load

Foundry VTT v13 + Pathfinder 1e module that cuts world load time on worlds with many unlinked tokens.

PF1's `TokenDocumentPF#prepareBaseData` calls `_syncSenses()`, which accesses `this.actor` first. For unlinked tokens this builds a full synthetic actor, and Foundry prepares the tokens of every scene during load. This module skips that sync while world documents are initializing and instead syncs the tokens of each scene as it is drawn. The sync runs in small slices while the scene's textures download (Foundry starts loading textures right after `canvasInit`), and anything left is finished in `canvasDraw`, before any token is drawn. Throttling scene images to 3 MB/s on the benchmark world, this overlap cut time to `ready` from 21.7s to 16.3s, with identical token vision data.

Manifest URL:

```
https://github.com/SolumNocta/pf1e-lazy-token-load/releases/latest/download/module.json
```

## Lazy actor preparation

At the end of world load Foundry prepares every world actor. For PF1 that costs roughly 40ms per actor, and it runs even for actors the current user cannot see. With this option on, actors the user has no permission to view skip that pass. The actor's prepared-data properties (`system`, `statuses`, `changes`, `sourceInfo`, `changeFlags`, `changeOverrides`) and its items' (`system`, `actions`, `changes`) become one-shot accessors: the first read of any of them prepares the actor, so callers always see prepared data. After `ready`, anything still deferred is prepared in the background, one actor per idle callback.

Client settings (reload to apply):

- **Lazy actor preparation** (default on)
- **Lazy actor preparation for GM** (default on): as a GM, also defer actors with no player owner
- **Lazy token actor preparation** (default on): see below
- **Background preparation of deferred actors** (default Smooth): after `ready`, deferred actors are prepared in the background, actors in combats and actors linked on the viewed and navigation scenes first.
  - *Smooth*: one actor per idle period, at least 50ms apart, and never within 750ms of mouse, wheel or keyboard input.
  - *Fast*: as quickly as idle time allows; on a large world this can stutter for a while after load.
  - *Off*: actors are prepared only when something reads their `system`. Untouched actors keep unprepared `changes`, `sourceInfo` and item actions for the session.

Only `itemFlags` and PF1's internal `_rollData` cache can't be trapped (Foundry makes them non-configurable); code that reads those of an untouched actor before anything else sees them unprepared until the actor is prepared. Turn the options off if a module misbehaves.

The console logs how many actors were deferred and how many were prepared on demand before `ready`. A high on-demand count means some module reads every actor at startup, which cancels the benefit.

## Lazy token actors

Reading `token.actor` on an unlinked token builds a synthetic actor, and PF1 fully prepares it. Some modules do that for every token in the world without needing the data: Sequencer's GM-only ready migration reads `token.actor` for every owned token just to look at a prototype-token flag, and then ignores unlinked tokens anyway. On the benchmark world that cost a GM about 20s per load.

Token actors are now deferred the same way as world actors, using the same one-shot accessors, but at any time rather than only during world load. The tokens of the scene being drawn are prepared before they are drawn; other token actors are prepared only when something reads their data (they are never part of the background pass). Foundry's `Actor` declares `statuses` as a class field, which is initialized after the constructor has already prepared a token actor, so that one property is trapped right after `ActorDelta#_createSyntheticActor` instead.

On the benchmark world with Sequencer 4.2.3, GM time to `ready` went from 30.8s to 16.0s. Derived data, statuses, changes, source info and items were identical for all 524 world actors and all 881 token actors. The only difference in roll data is PF1's transient `dcBonus: 0`, which the roll-data cache holds right after any preparation until the next refresh.

If the Actors directory is slow for a GM: koboldworks-pf1-little-helper's "Enrich Actors Directory" reads every listed actor's prepared data (type, CR) when the directory renders, which prepares all of them. Turning that feature off avoids it.

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
| v1.4.0 defaults, Sequencer 4.2.3 active | 3.4s | 13.6s | 16.0s (v1.3.1: 30.8s) |

With lazy actors on, derived data (AC, CMD, HP, saves, abilities, skills, encumbrance, item state) was identical to a normal load for all 524 actors once background prep finished.

pf1-pow's GM-only `ready` migration reads `system.skills` on every actor. When both of its skills (`kmt`, `ahp`) are already stored, that read is served from stored data instead of preparing the actor, since preparation never removes stored skills and the migration reaches the same answer. Otherwise the actor is prepared as usual.

Known difference: pf1-psionics attaches its actor helper in its own `ready` hook, so actors prepared after `ready` cache roll data that includes `psionics.powerPoints`, while actors prepared during load do not. Lazily prepared actors are in the same state any actor reaches after its first update in a session.
