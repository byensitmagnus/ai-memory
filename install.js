#!/usr/bin/env node
'use strict';
/**
 * ai-memory installer.
 *
 *   node install.js              install or update
 *   node install.js --check      show what would change, touch nothing
 *   node install.js --uninstall  unregister hooks, leave your content alone
 *   node install.js --doctor     read-only installation health check
 *
 * Node 18+. No dependencies. Everything happens inside your home directory.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = __dirname;
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const AIMEM = path.join(HOME, '.ai-memory');
const CLAUDE = path.join(HOME, '.claude');
const CODEX = path.join(HOME, '.codex');
const GROK = path.join(HOME, '.grok');

const CHECK = process.argv.includes('--check');
const UNINSTALL = process.argv.includes('--uninstall');
const DOCTOR = process.argv.includes('--doctor');

/** Every hook we register runs this. It is also how --uninstall finds them again. */
const MARKER = '.ai-memory/sync.js';
const COMMAND = `node "${path.join(AIMEM, 'sync.js').replace(/\\/g, '/')}"`;
const CLAUDE_EVENTS = ['SessionStart', 'Stop', 'SessionEnd'];
// Codex currently exposes SessionStart and Stop, but not Claude's SessionEnd.
// Keeping this list separate avoids installing a hook Codex will never run.
const CODEX_EVENTS = ['SessionStart', 'Stop'];
const GROK_EVENTS = ['SessionStart', 'Stop', 'SessionEnd'];

let changed = 0;
const notes = [];
const log = (m) => console.log(`[ai-memory] ${m}`);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };

if (DOCTOR) {
  try {
    execFileSync(process.execPath, [path.join(AIMEM, 'doctor.js')], { stdio: 'inherit' });
  } catch (error) {
    process.exitCode = error.status || 1;
  }
  process.exit();
}

function write(dest, content, { backup = false } = {}) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const cur = read(dest);
  if (cur && cur.equals(buf)) return false;
  if (CHECK) { console.log(`  ~ ${dest}`); changed++; return true; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (cur && backup) fs.writeFileSync(`${dest}.bak-${stamp()}`, cur);
  fs.writeFileSync(dest, buf);
  changed++;
  return true;
}

function readJson(p, fallback) {
  const raw = read(p);
  if (!raw) return fallback;
  try { return JSON.parse(raw.toString('utf8')); } catch {
    notes.push(`${p} is not valid JSON — left untouched. Register the hook by hand, see README.`);
    return null;
  }
}

/**
 * Adds our hook to an existing settings object without disturbing anything else.
 * Both Claude Code and Codex use the same shape, so one function covers both.
 */
function hasOurHook(command) {
  const value = String(command || '');
  // Older installations used a tiny node -e wrapper with the path split into
  // two string literals. Recognise it so an update does not duplicate hooks.
  return value.includes(MARKER) || (value.includes('.ai-memory') && value.includes('sync.js'));
}

function registerHooks(cfg, timeout, events) {
  cfg.hooks = cfg.hooks || {};
  for (const ev of events) {
    const list = Array.isArray(cfg.hooks[ev]) ? cfg.hooks[ev] : [];
    const already = list.some((g) => (g.hooks || []).some((h) => hasOurHook(h.command)));
    if (already) continue;
    list.push({ matcher: '*', hooks: [{ type: 'command', command: COMMAND, timeout }] });
    cfg.hooks[ev] = list;
  }
  return cfg;
}

function unregisterHooks(cfg) {
  if (!cfg.hooks) return cfg;
  for (const ev of Object.keys(cfg.hooks)) {
    if (!Array.isArray(cfg.hooks[ev])) continue;
    cfg.hooks[ev] = cfg.hooks[ev]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(MARKER)) }))
      .filter((g) => (g.hooks || []).length > 0);
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  return cfg;
}

function patchSettings(file, timeout, label, events = CLAUDE_EVENTS) {
  const cfg = readJson(file, {});
  if (cfg === null) return;
  const next = UNINSTALL ? unregisterHooks(cfg) : registerHooks(cfg, timeout, events);
  if (write(file, JSON.stringify(next, null, 2) + '\n', { backup: true })) {
    log(`${UNINSTALL ? 'unregistered' : 'registered'} hooks in ${label}`);
  }
}

// ---------------------------------------------------------------------------
log(CHECK ? 'dry run — nothing will be written' : `${UNINSTALL ? 'uninstalling from' : 'installing to'} ${HOME}`);

if (UNINSTALL) {
  patchSettings(path.join(CLAUDE, 'settings.json'), 30, '~/.claude/settings.json', CLAUDE_EVENTS);
  if (fs.existsSync(CODEX)) patchSettings(path.join(CODEX, 'hooks.json'), 30, '~/.codex/hooks.json', CODEX_EVENTS);
  const grokHook = path.join(GROK, 'hooks', 'ai-memory.json');
  if (fs.existsSync(grokHook) && !CHECK) { fs.rmSync(grokHook, { force: true }); changed++; log('removed ~/.grok/hooks/ai-memory.json'); }
  console.log('');
  log(`done — ${changed} file(s) changed`);
  console.log('');
  console.log('Left in place on purpose:');
  console.log(`  ~/.ai-memory/          your INSTRUCTIONS, CONTEXT and MEMORY`);
  console.log(`  ~/.claude/CLAUDE.md    last generated package — delete it yourself if you want it gone`);
  process.exit(0);
}

// 1) Engine ------------------------------------------------------------------
for (const f of ['sync.js', 'sync-claude-to-codex.js', 'codex-notify.js', 'doctor.js']) {
  write(path.join(AIMEM, f), fs.readFileSync(path.join(REPO, 'src', f)));
}

// 2) Your three files — created once, never overwritten -----------------------
const created = [];
for (const f of ['INSTRUCTIONS.md', 'CONTEXT.md', 'MEMORY.md']) {
  const dest = path.join(AIMEM, f);
  if (fs.existsSync(dest)) continue;
  write(dest, fs.readFileSync(path.join(REPO, 'templates', f)));
  created.push(f);
}

// 3) Hooks --------------------------------------------------------------------
patchSettings(path.join(CLAUDE, 'settings.json'), 30, '~/.claude/settings.json', CLAUDE_EVENTS);

if (fs.existsSync(CODEX)) {
  patchSettings(path.join(CODEX, 'hooks.json'), 30, '~/.codex/hooks.json', CODEX_EVENTS);
  const cfg = (read(path.join(CODEX, 'config.toml')) || Buffer.from('')).toString('utf8');
  if (!/^\s*hooks\s*=\s*true/m.test(cfg)) {
    notes.push('Codex: hooks must be enabled. Add `hooks = true` under `[features]` in ~/.codex/config.toml');
  }
} else {
  notes.push('Codex not found — skipped. Install it and run this again.');
}

if (fs.existsSync(GROK)) {
  const hooks = { hooks: Object.fromEntries(GROK_EVENTS.map((ev) => [ev, [{ hooks: [{ type: 'command', command: COMMAND, timeout: 30 }] }]])) };
  write(path.join(GROK, 'hooks', 'ai-memory.json'), JSON.stringify(hooks, null, 2) + '\n', { backup: true });
  const cfg = (read(path.join(GROK, 'config.toml')) || Buffer.from('')).toString('utf8');
  if (!/agents\s*=\s*false/.test(cfg)) {
    notes.push('Grok: set `agents = false` under `[compat.claude]` in ~/.grok/config.toml, or you get the package twice');
  }
} else {
  notes.push('Grok not found — skipped.');
}

// 4) Generate once so you can see it worked -----------------------------------
if (!CHECK) {
  try {
    execFileSync(process.execPath, [path.join(AIMEM, 'sync.js')], { stdio: 'inherit' });
  } catch (e) {
    notes.push(`sync.js failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log('');
log(CHECK ? `dry run: ${changed} change(s) would be made` : `done — ${changed} file(s) changed`);
console.log('');
console.log('Edit these, everything else is generated:');
for (const f of ['INSTRUCTIONS.md', 'CONTEXT.md', 'MEMORY.md']) {
  console.log(`  ${path.join(AIMEM, f)}${created.includes(f) ? '   (created from template)' : ''}`);
}
if (notes.length) {
  console.log('');
  console.log('Before it fully works:');
  notes.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));
}
console.log('');
console.log('Restart your harness. Then check ~/.claude/CLAUDE.md.');
