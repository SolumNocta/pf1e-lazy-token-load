# PF1e Lazy Token Load

Foundry VTT v13 + Pathfinder 1e module that cuts world load time on worlds with many unlinked tokens.

PF1's `TokenDocumentPF#prepareBaseData` calls `_syncSenses()`, which accesses `this.actor` first. For unlinked tokens this builds a full synthetic actor, and Foundry prepares the tokens of every scene during load. This module skips that sync while world documents are initializing and instead syncs the tokens of each scene as it is drawn (`canvasInit`).

Manifest URL:

```
https://github.com/SolumNocta/pf1e-lazy-token-load/releases/latest/download/module.json
```

## Lazy actor preparation

At the end of world load Foundry prepares every world actor. For PF1 that costs roughly 40ms per actor, and it runs even for actors the current user cannot see. With this option on, actors the user has no permission to view skip that pass. Their `system`, `items` and `effects` become one-shot accessors: the first read prepares the actor, so callers always see prepared data. After `ready`, anything still deferred is prepared in the background, one actor per idle callback.

Client settings (reload to apply):

- **Lazy actor preparation** (default on)
- **Lazy actor preparation for GM** (default off): as a GM, also defer actors with no player owner

The console logs how many actors were deferred and how many were prepared on demand before `ready`. A high on-demand count means some module reads every actor at startup, which cancels the benefit.
