# PF1e Lazy Token Load

Foundry VTT v13 + Pathfinder 1e module that cuts world load time on worlds with many unlinked tokens.

PF1's `TokenDocumentPF#prepareBaseData` calls `_syncSenses()`, which accesses `this.actor` first. For unlinked tokens this builds a full synthetic actor, and Foundry prepares the tokens of every scene during load. This module skips that sync while world documents are initializing and instead syncs the tokens of each scene as it is drawn (`canvasInit`).

Manifest URL:

```
https://github.com/SolumNocta/pf1e-lazy-token-load/releases/latest/download/module.json
```
