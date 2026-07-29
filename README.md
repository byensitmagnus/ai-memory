# ai-memory

**A small, local control plane for Claude Code, Codex and Grok.**

Write your working rules once. `ai-memory` renders the same package into all
three harnesses, carries short session recall across them, and keeps reusable
skills, agents and project instructions aligned. It is dependency-free Node.js
and has no network calls or telemetry.

This repository is the **portable engine**. Your real business context,
project notes, credentials and personal memory remain in a private vault —
never in this public repository.

```text
Private Obsidian vault                 Local AI installations
---------------------                 ----------------------
00-AI/ai-memory/ ────────────────►    ~/.claude/CLAUDE.md
  INSTRUCTIONS.md                      ~/.codex/AGENTS.md
  CONTEXT.md                           ~/.grok/rules/00-ai-memory.md
  MEMORY.md
        │
        └── Syncthing (LAN) ─────► second machine
```

## What it solves

| Problem | What ai-memory does |
| --- | --- |
| Claude, Codex and Grok give different answers | Renders one **byte-identical** home package into all three tools. |
| A switch of AI loses useful context | Imports recent Codex and Grok session summaries into the shared package. |
| A skill exists only in one tool | Bridges skills, agents, commands and project instructions from the Claude-compatible source. |
| A setup silently drifts | `doctor.js` reports the exact broken target without changing files. |
| A second machine becomes a parallel brain | Keep canonical content in a private Obsidian vault and sync that vault, not entire home folders. |

## Start here

Requires Node 18+. No `npm install`.

```bash
git clone https://github.com/byensitmagnus/ai-memory.git
node ai-memory/install.js --check
node ai-memory/install.js
node ai-memory/install.js --doctor
```

Edit only these sources in `~/.ai-memory/`:

| File | Put this there |
| --- | --- |
| `INSTRUCTIONS.md` | How every AI should behave: scope, verification, output style. |
| `CONTEXT.md` | Your active environment: role, stack, local paths and hard rules. Optional. |
| `MEMORY.md` | Durable facts, decisions and expensive traps. Not daily scratch notes. |

The installer never overwrites those three files after creating them once. It
backs up a settings file before editing it and merges only its own hooks.

Run a read-only check any time:

```bash
node ~/.ai-memory/doctor.js
# or: node ai-memory/install.js --doctor
```

Expected finish: `100% ALIGNED`.

## The complete operating model

`ai-memory` is deliberately just one layer of a healthy AI setup:

1. **Public engine — this repository.** Portable scripts, neutral templates,
   tests and documentation. Safe to share and audit.
2. **Private Brain — your Obsidian vault.** Goals, project state, decisions,
   custom skills and real memory. This is your canonical data.
3. **Local adapters — Claude, Codex and Grok.** Generated files and local
   discovery links. Rebuildable on every machine; never the source of truth.
4. **LAN sync — Syncthing.** Synchronises the private vault between machines.
   Git is optional revision history, not live file replication.

The detailed design and two-machine procedure are in
[Architecture](docs/ARCHITECTURE.md) and [Obsidian + Syncthing](docs/OBSIDIAN-SYNCTHING.md).

## What gets generated

Every run writes the same bytes to:

```text
~/.claude/CLAUDE.md
~/.codex/AGENTS.md
~/.grok/rules/00-ai-memory.md
```

The generated package contains, in this order:

1. `INSTRUCTIONS.md`
2. `CONTEXT.md` when present
3. `MEMORY.md`
4. the most recent cross-harness session summaries
5. an on-demand map of Claude project memory

It is fenced with `AI-MEMORY` markers. Never edit the generated files directly:
the next sync intentionally replaces them.

## Safe boundaries

This is the distinction that prevents a shared-memory setup from leaking or
breaking:

- Keep business context, customer data, tokens, `.env` files and raw chat
  archives in a **private** vault/repository.
- Keep third-party skills at their original licensed source. Do not copy a
  whole local skill library into this project.
- Sync only canonical content between computers. Do not sync `~/.claude`,
  `~/.codex` or `~/.grok` wholesale: caches, sessions, plugins and credentials
  are machine-specific.
- Import watermarks live in `~/.ai-memory-runtime/`, deliberately outside the
  shared source folder, so one computer cannot suppress another computer's
  session import.
- Treat `sync-conflict-*` files as evidence, not garbage. Compare the two
  versions, resolve the content, then archive the conflict copies.

See [Security and privacy](docs/SECURITY.md) before sharing a vault or making a
repository public.

## Integrations from the broader AI setup

The engine is intentionally compatible with a wider stack rather than trying
to own it all:

- [ECC](https://github.com/affaan-m/ecc) for a curated skill/agent framework.
- [i-have-adhd](https://github.com/ayghri/i-have-adhd) for concise,
  action-first output rules.
- Obsidian for visible, editable long-term memory.
- Syncthing for direct, encrypted LAN replication between machines.

[Integration boundaries](docs/INTEGRATIONS.md) explains what belongs in each
place and what must stay private.

## Verification and development

```bash
npm test
node install.js --check
node install.js --doctor
```

The tests use Node's built-in test runner and real temporary home directories.
The GitHub Actions matrix runs them on Windows, macOS and Linux with Node 18,
22 and 24.

Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

For the mechanics of session import, managed blocks and the bridge, see
[How it works](docs/HOW-IT-WORKS.md).

## Remove it

```bash
node ai-memory/install.js --uninstall
```

Only ai-memory's hooks are removed. Your three source files and the last
generated package stay in place until you choose to remove them.

## Licence

MIT. Built at [Byens IT](https://www.byens-it.dk) in Denmark.
