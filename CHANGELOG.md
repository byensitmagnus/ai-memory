# Changelog

## 2.0.0 — 2026-08-21

- Expanded the byte-identical package to Kimi, Cursor and ZCode alongside
  Claude Code, Codex and Grok.
- Added native lifecycle hooks for Codex, Cursor, Kimi CLI/Desktop and ZCode,
  with metadata-only Kimi/ZCode recall and no prompt injection into generated
  instructions.
- Kimi Desktop workspace instructions now use one managed block and preserve
  existing project-specific `AGENTS.md` rules.
- Disabled competing Grok and ZCode native-memory switches during install while
  preserving their existing data. Cursor's SQLite setting remains a read-only
  doctor gate because it must be changed through Cursor's UI.
- Isolated Grok's native lifecycle adapter from imported Claude/Cursor hooks, so
  each event runs shared-memory sync exactly once.
- Expanded `doctor.js` to verify hook events, native-memory contracts, Cursor
  `alwaysApply`, Kimi Desktop plugin bytes, ZCode selftest and whether
  `~/.ai-memory` physically belongs to a registered Obsidian vault.
- Added fail-closed TOML repair, idempotent hook merging, owned Kimi Desktop
  plugin cleanup on uninstall and 37 integration tests.

## 1.1.0 — 2026-07-29

- Added a read-only `doctor.js` with byte-hash, managed-block and skill-bridge
  checks. Run `node install.js --doctor` after install or on either machine.
- Added the complete public/private architecture: a private Obsidian Brain,
  local Claude/Codex/Grok adapters and Syncthing as LAN replication.
- Made session-import watermarks machine-local. A Syncthing-backed vault can no
  longer cause one machine to skip another machine's session history.
- Fixed the installer to recognise legacy ai-memory hooks without duplicating
  them and to avoid unsupported Codex `SessionEnd` hooks.
- Added decision and project-status templates, security guidance and
  integration/licensing boundaries.

## 1.0.0 — 2026-07-29

- Initial public release: byte-identical shared instructions, cross-harness
  session recall and the Claude-to-Codex/Grok bridge.
