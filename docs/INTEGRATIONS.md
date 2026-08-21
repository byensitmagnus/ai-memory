# Integration boundaries

The strongest setup uses specialised tools without turning one repository into
an unmaintainable dump of copied files.

| Component | Owns | Does not own |
| --- | --- | --- |
| `ai-memory` | Shared home instructions, bounded session recall, bridge, health checks | Your actual business memory or a giant skill library |
| Obsidian | Human-readable private Brain and decisions | Local app configuration for every AI |
| Syncthing | Live encrypted LAN replication of the private vault | Git history, secrets management or conflict decisions |
| Git | Reviewable history of safe repositories | Live multi-device file sync |
| ECC | Its own skills, agents and framework conventions | Your personal operating rules |
| i-have-adhd | Output-form ideas | Your entire instruction package |

## Skills and agents

Install third-party skills from their original project, respecting that
project's licence. Keep private or business-specific skills in your private
Brain. `sync-claude-to-codex.js` makes the discovered inventory available to
the supported local harnesses; it does not grant a licence to redistribute it.

## ChatGPT

ChatGPT web/mobile has no local filesystem or hook access. It cannot read this
Obsidian-backed package unless a separate connector, Project instruction or
Custom GPT is configured. Codex running locally can use the package; generic
ChatGPT is intentionally outside `doctor.js`'s proof boundary.

## Why the boundary matters

A public engine can be audited, versioned and shared with a teammate. A private
Brain can contain real decisions and project state. Mixing them means every
improvement to the engine risks publishing the thing the engine was built to
protect.
