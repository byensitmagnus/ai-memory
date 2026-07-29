# Changelog

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
