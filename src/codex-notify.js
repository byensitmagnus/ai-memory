#!/usr/bin/env node
'use strict';
/**
 * Codex `notify`-program. Codex kalder den med ét JSON-argument pr. event.
 * Vi kører den fælles sync ved hver fuldført tur, så alle genererede targets
 * + den delte session-store holdes friske fra Codex-siden. Fejler aldrig hårdt.
 */
const path = require('path');
const { spawnSync } = require('child_process');

try {
  let type = '';
  try { type = (JSON.parse(process.argv[2] || '{}').type) || ''; } catch {}
  // Kør kun ved tur-afslutning (undgå unødig churn). Tom type => kør alligevel.
  if (type && type !== 'agent-turn-complete') process.exit(0);
  spawnSync(process.execPath, [path.join(__dirname, 'sync.js')], {
    stdio: 'ignore',
    timeout: 30000,
  });
} catch { /* aldrig blokér Codex */ }
process.exit(0);
