# Project overview

`ai-memory` is a local Node.js engine for shared instructions, adapters, hooks and
bounded session metadata across several coding harnesses. The public repository
contains portable infrastructure; real memory and business context stay private.

## Read-only first look

From the repository root, with Node.js 18 or newer:

```sh
node install.js --check
```

This previews installer-owned engine/config changes without writing them. Inspect
that output before following the installation instructions in the README.
After installation, `node install.js --doctor` is the separate read-only check
for generated packages, hooks and ownership. A preview is not a health-check pass.

For a synthetic source example, imagine an `INSTRUCTIONS.md` containing
“Use the existing formatter”, a `CONTEXT.md` describing a fictional demo project,
and a `MEMORY.md` recording its fictional decisions. The real workflow keeps
these sources outside the public engine repository.

```mermaid
flowchart LR
    A[Private source files] --> B[Bridge skills and adapters]
    B --> C[Import bounded session metadata]
    C --> D[Render local instruction packages]
    D --> E[Read-only doctor]
```

The diagram explains the documented design; it is not a benchmark or runtime
screenshot. Host support and installation details are in the
[README](../README.md). Review [security and privacy](SECURITY.md) before sharing
files, and [how it works](HOW-IT-WORKS.md) before enabling hooks.
