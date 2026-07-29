# Obsidian + Syncthing: two-machine setup

Use this when the same private Brain must work on a Windows PC and a Mac.
It keeps live file replication, revision history and local tool configuration
in their proper places.

## Design rules

1. Pick one private vault folder as the canonical Brain on **both** machines.
   Do not maintain parallel `brain`, `vault-new` and `vault-final` folders.
2. Set the Syncthing folder to **Send & Receive** on both machines. Send Only
   is useful for a deliberate one-time seed, not as the normal state.
3. Turn on Simple File Versioning (for example, keep 30 versions). This is the
   fast recovery path for accidental overwrites.
4. Open that exact folder in Obsidian via the vault chooser. Never repair a
   wrong active vault by moving, renaming or deleting folders.
5. Sync the vault, not `~/.claude`, `~/.codex` or `~/.grok`. Those folders hold
   caches, credentials and transient sessions that are not portable state.

## Recommended layout

```text
MagnusBrain/                         # private vault, same logical content
  00-AI/
    ai-memory/                       # sources + installed ai-memory scripts
    harness/claude/skills/            # private/custom skills if appropriate
    memory/                           # shared durable memory
    project-memory/                   # shared project state
  04-projects/
  05-decisions/
  90-archive/                         # technical backups; do not live-sync
```

Local compatibility paths may be links into the vault, for example
`~/.ai-memory` → `MagnusBrain/00-AI/ai-memory`. Create those links through a
checked bootstrap script on each operating system; do not copy files by hand.
The tool discovers the same logical source on both machines, while each app
keeps its own local cache and sign-in state.

## Syncthing exclusions

Put the same intent in `.stignore` on both devices. A conservative starting
point:

```text
.git
.stversions
.obsidian/workspace*.json
.obsidian/cache/
/90-archive
```

`90-archive` is for local technical snapshots and old backups. Keep real
project archives somewhere else if they need to be available on both machines.
Syncthing does not automatically sync the `.stignore` file itself, so verify
the ignore rule on each endpoint.

## First pairing

1. Create a ZIP backup of the existing vault on each machine.
2. Choose the complete vault as the source and let Syncthing finish its first
   transfer before editing on the receiving machine.
3. Change both endpoints to Send & Receive, enable versioning and confirm
   `Need files = 0`, `Pull errors = 0` and remote completion is 100%.
4. In Obsidian, select the canonical vault and remove old vault registrations
   from the UI only.
5. Run `node ~/.ai-memory/doctor.js` on both machines. The three generated
   package hashes must match per machine.

## If a conflict appears

Never bulk-delete `sync-conflict-*` files. Open both versions, keep the facts
from each, save one resolved canonical note and then archive the conflict copy.
When a conflict touches `MEMORY.md`, project state or an instruction file,
resolve it before doing more AI work: it changes what every tool will read.
