# Architecture

`ai-memory` avoids two common failures of an “AI memory” setup: every app
becomes its own source of truth, or a public repository accidentally becomes a
backup of private business data.

```text
                          public, reusable, audited
                    ┌──────────────────────────────┐
                    │          ai-memory            │
                    │ scripts · templates · tests   │
                    └──────────────┬───────────────┘
                                   │ install/update
                                   ▼
private, canonical   ┌──────────────────────────────┐  local, rebuildable
──────────────────►  │        Obsidian vault         │  ┌───────────────────┐
                      │  00-AI/ai-memory/             │──│ Claude Code       │
                      │  projects/ · decisions/       │  ├───────────────────┤
                      │  custom skills/               │──│ Codex             │
                      └──────────────┬───────────────┘  ├───────────────────┤
                                     │                  │ Grok · Kimi       │
                                     │                  ├───────────────────┤
                                     │                  │ Cursor · ZCode    │
                       Syncthing LAN │                  └───────────────────┘
                                     ▼
                      ┌──────────────────────────────┐
                      │        second machine         │
                      │  same vault, local adapters   │
                      └──────────────────────────────┘
```

## 1. Public engine

This repository contains only generic, inspectable code:

- the installer and hooks;
- the byte-identical package renderer;
- the cross-harness skill/agent/command bridge;
- read-only diagnostics, tests and neutral templates.

It must never contain actual memory, customer information, credentials,
machine-specific project paths or copied third-party skills.

## 2. Private Brain

Create a private vault/repository for the things that are true only for you or
your business. A practical layout is:

```text
00-AI/
  ai-memory/                 # INSTRUCTIONS, CONTEXT, MEMORY + installed scripts
  memory/                     # cross-project durable notes
  project-memory/<slug>/      # project-specific current state
  harness/claude/skills/      # your original / licensed custom skills
  scripts/                    # your bootstrap and vault doctor
03-goals/
04-projects/
05-decisions/
10-inbox/
90-archive/
```

The exact folder names do not matter. The rule does: one canonical copy of
content, and local tool folders only point to it or are generated from it.
Import watermarks are deliberately kept in `~/.ai-memory-runtime/` on each
computer; they are runtime state, not shared memory.

## 3. Generated adapters

`sync.js` is the only writer of the generated home instruction files. It combines:

- behaviour (`INSTRUCTIONS.md`),
- local/business context (`CONTEXT.md`),
- durable facts (`MEMORY.md`),
- bounded session recall, and
- a compact project-memory map.

That makes a harness swap a continuation of the same work, not a new blank
conversation. The output is byte-identical by design; hash comparison is a
real drift check, not a visual guess.

`sync-claude-to-codex.js` bridges discovered skills, agents, slash commands and
project-level instructions. The original source is preserved; generated
adapters carry explicit markers so they can be regenerated safely.

Competing native-memory switches are kept off where they would fork the Brain.
Grok and ZCode are repaired by the installer. Cursor uses native
`sessionStart` refresh/context injection plus `afterAgentResponse` write-back;
its effective Memory state is checked read-only. Privacy Mode makes the legacy
Memory toggle inactive, so `doctor.js` verifies both values instead of treating
a stale toggle as runtime proof. Kimi CLI/Desktop use native lifecycle hooks;
their shared records contain metadata only.

## 4. Project memory protocol

Keep three kinds of information separate:

| Type | Home | Write policy |
| --- | --- | --- |
| Cross-project durable fact | `00-AI/memory/` | Update when it will matter next month. |
| Project state | `04-projects/<name>/STATUS.md` or `project-memory/<slug>/` | Update after meaningful work, decision or blocker. |
| Personal note or journal | Your note area | Never edit automatically. |

Decisions should be append-only. A useful decision note contains: date, choice,
why, rejected alternative and the condition that would reopen it. The template
in `templates/DECISION.md` is intentionally small.

## 5. Recovery model

Each layer has a clear recovery path:

- A broken local installation: re-run `install.js` then `doctor.js`.
- A broken adapter link: run the bridge; do not duplicate the skill folder.
- A bad sync merge: recover a Syncthing file version or Git revision, then
  resolve it in the canonical vault.
- A wrong active Obsidian vault: switch through Obsidian's vault chooser; do
  not move vault folders to “fix” the UI.

This turns an impressive-looking setup into one that can survive a second
machine, a plugin update or a bad day.
