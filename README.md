# ai-memory

**One identical instruction file for Claude Code, Codex and Grok — plus session memory that crosses between them.**

You switch harnesses during the day. Claude Code in the morning, Codex in the afternoon, Grok when
you want a second opinion. Each one reads a different instruction file from your home directory, and
each one starts every session with no idea what the others did.

`ai-memory` fixes both halves of that:

1. **One package, three files.** Your rules are written once and rendered **byte-identically** into
   `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and `~/.grok/rules/00-ai-memory.md`.
2. **Sessions carry over.** What you did in Codex this morning is in Claude Code's context this
   afternoon — and the other way round.

It is a small tool. ~950 lines of dependency-free Node. It does not ship agents, skills or opinions
about how you should write code. If you want a full harness framework, use
[ECC](https://github.com/affaan-m/ecc) — this composes with it.

---

## Install

Requires **Node 18+**. No npm install, no dependencies.

```bash
git clone https://github.com/byensitmagnus/ai-memory.git
node ai-memory/install.js
```

See what it would do first:

```bash
node ai-memory/install.js --check
```

Remove it again — hooks unregistered, your content left alone:

```bash
node ai-memory/install.js --uninstall
```

The installer **merges** into an existing `~/.claude/settings.json` rather than replacing it, and
backs it up first. It never overwrites your `MEMORY.md`, `CONTEXT.md` or `INSTRUCTIONS.md` once they
exist.

---

## Start using it

Edit three files in `~/.ai-memory/`. Everything else is generated.

| File | What belongs in it |
|---|---|
| `INSTRUCTIONS.md` | How the agent should behave. Coding standards, output form, when to ask. |
| `CONTEXT.md` | Your project or business. Stack, hard rules, where things live. |
| `MEMORY.md` | Durable facts. Decisions you don't want to relitigate, traps you already paid for. |

Then just work. The hooks run `sync.js` on session start and stop; you never call it by hand. Verify
any time with:

```bash
node ~/.ai-memory/sync.js
```

**Never edit `~/.claude/CLAUDE.md` directly.** It is generated and will be overwritten. Each block is
fenced with `<!-- AI-MEMORY:<TAG>:START -->` markers so you can see where content came from.

---

## What ends up in the generated file

Four blocks, in this order:

1. **INSTRUCTIONS** — from `INSTRUCTIONS.md`, verbatim.
2. **CONTEXT** — from `CONTEXT.md`, verbatim. Omitted entirely if the file doesn't exist.
3. **DURABLE** — from `MEMORY.md`, verbatim.
4. **SESSIONS** — the 12 most recent sessions across all three harnesses, one line each.
5. **MEMORY-MAP** — an index of every `~/.claude/projects/<slug>/memory/` folder, so the agent knows
   what it can read on demand instead of you pasting it in.

Each project's index is capped at 3.500 characters, so the map can't run away with your context.

---

## Cross-harness session memory

This is the part that has no equivalent elsewhere.

- **Codex** writes `rollout-*.jsonl` per session. `sync.js` parses them, strips the product wrappers
  (`<permissions>`, `<user_instructions>`, recommended-plugins blocks) that would otherwise drown the
  actual task, and keeps your last 10 real prompts plus the files that were patched.
- **Grok** writes `summary.json` plus a workspace-level `prompt_history.jsonl`. Same treatment.
- Both are normalised into `~/.claude/session-data/*.tmp` and the 12 newest are rendered into the
  package.

Imports are incremental (watermarked in `.sync-state.json`), capped at 25 files and 14 days, so a
long history doesn't slow down session start.

---

## The skills bridge

`sync-claude-to-codex.js` mirrors `~/.claude/skills`, `agents` and `commands` into `~/.codex` and
`~/.agents`, and writes per-project `AGENTS.md` next to your `CLAUDE.md`. Grok reads both locations
natively via `[compat.claude]` in its `config.toml`.

Net effect: **install a skill once, all three harnesses have it.**

Windows note: those directories are junctions. Delete a skill on one side only and the next sync
restores it — remove it from both `~/.claude/skills` and `~/.agents/skills`.

---

## Why not just symlink the files?

Because the three harnesses don't want the same *file*, they want the same *content* in different
places, with different surrounding conventions — and because a symlink can't merge in session history
from a fourth source. It also breaks differently on Windows, macOS and Linux. Generating is boring
and it works everywhere.

---

## Platform support

| | Claude Code | Codex | Grok |
|---|---|---|---|
| Generated instruction file | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.grok/rules/00-ai-memory.md` |
| Hooks registered by installer | ✅ merged into `settings.json` | ✅ `hooks.json` | ✅ `hooks/ai-memory.json` |
| Session import | source | ✅ | ✅ |
| Skills bridged in | source | ✅ | ✅ |

Tested on Windows 11 and macOS. Linux should work — the code has no platform branches beyond path
handling — but is untested.

Missing harness? `sync.js` writes to a list called `HOME_TARGETS`. Adding a fourth is one line.

---

## What is deliberately not here

- **No agents, skills or rules.** Those are opinions, and good ones already exist. 44 of the skills in
  our own private setup come from [ECC](https://github.com/affaan-m/ecc) (MIT) — get them there,
  not repackaged by us.
- **No telemetry, no network calls.** The whole thing is file reads and writes in your home directory.
- **No package to install.** Clone it and read the 950 lines. It runs on every session start; you
  should be able to audit it in one sitting.

---

## Credit

Built at [Byens IT](https://www.byens-it.dk) (Denmark) while running Claude Code, Codex and Grok on
the same projects and getting tired of three different answers.

The hook-profile pattern and much of our own skill library come from
[affaan-m/ecc](https://github.com/affaan-m/ecc) (MIT). The output-form rules in the example
`INSTRUCTIONS.md` are adapted from [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) (MIT).

MIT licensed. See [LICENSE](LICENSE).
