#!/usr/bin/env node
'use strict';
/**
 * ai-memory installer.
 *
 *   node install.js              install or update
 *   node install.js --check      preview installer-owned files/config, touch nothing
 *   node install.js --uninstall  unregister hooks, leave your content alone
 *   node install.js --doctor     read-only installation health check
 *
 * Node 18+. No dependencies. Everything happens inside your home directory.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { appDataRoot, kimiDesktopRunnerCandidates } = require('./src/platform-paths-(C)');

const REPO = __dirname;
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const AIMEM = path.join(HOME, '.ai-memory');
const CLAUDE = path.join(HOME, '.claude');
const CODEX = path.join(HOME, '.codex');
const GROK = path.join(HOME, '.grok');
const CURSOR = path.join(HOME, '.cursor');
const KIMI = path.join(HOME, '.kimi');
const ZCODE = path.join(HOME, '.zcode');
const APPDATA = appDataRoot(HOME);
const KIMI_DESKTOP_HOME = path.join(APPDATA, 'kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home');
const KIMI_DESKTOP_RUNNER = kimiDesktopRunnerCandidates(APPDATA, HOME).find((candidate) => fs.existsSync(candidate));

const CHECK = process.argv.includes('--check');
const UNINSTALL = process.argv.includes('--uninstall');
const DOCTOR = process.argv.includes('--doctor');

/** Every hook we register runs this. It is also how --uninstall finds them again. */
const MARKER = '.ai-memory/sync.js';
const COMMAND = `"${process.execPath.replace(/\\/g, '/')}" "${path.join(AIMEM, 'sync.js').replace(/\\/g, '/')}"`;
const CLAUDE_EVENTS = ['SessionStart', 'Stop', 'SessionEnd'];
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
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !hasOurHook(h.command)) }))
      .filter((g) => (g.hooks || []).length > 0);
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  return cfg;
}

function patchSettings(file, timeout, label, events = CLAUDE_EVENTS) {
  if (UNINSTALL && !fs.existsSync(file)) return;
  const cfg = readJson(file, {});
  if (cfg === null) return;
  const next = UNINSTALL ? unregisterHooks(cfg) : registerHooks(cfg, timeout, events);
  if (write(file, JSON.stringify(next, null, 2) + '\n', { backup: true })) {
    log(`${UNINSTALL ? 'unregistered' : 'registered'} hooks in ${label}`);
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlBooleanIsUnambiguous(raw, section, key) {
  const lines = String(raw || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = new RegExp(`^\\s*\\[${escapeRegex(section)}\\]\\s*(?:#.*)?$`);
  const starts = lines.map((line, index) => header.test(line) ? index : -1).filter((index) => index >= 0);
  if (starts.length > 1) return false;
  if (!starts.length) return true;
  let end = lines.length;
  for (let index = starts[0] + 1; index < lines.length; index++) {
    if (/^\s*\[/.test(lines[index])) { end = index; break; }
  }
  const assignment = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  const values = lines.slice(starts[0] + 1, end).filter((line) => assignment.test(line));
  return values.length <= 1 && (!values.length || new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?$`).test(values[0]));
}

/** Change one boolean inside one TOML table without parsing or logging secrets. */
function setTomlBoolean(file, section, key, value, label, backup = true) {
  const current = read(file);
  const original = current ? current.toString('utf8') : '';
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? original.slice(1) : original;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  const header = new RegExp(`^\\s*\\[${escapeRegex(section)}\\]\\s*(?:#.*)?$`);
  const sectionIndexes = lines.map((line, index) => header.test(line) ? index : -1).filter((index) => index >= 0);
  if (sectionIndexes.length > 1) {
    notes.push(`${label}: duplicate [${section}] tables — left untouched.`);
    return false;
  }

  if (!sectionIndexes.length) {
    if (lines.length && lines.at(-1).trim()) lines.push('');
    lines.push(`[${section}]`, `${key} = ${value}`);
  } else {
    const start = sectionIndexes[0];
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
      if (/^\s*\[/.test(lines[index])) { end = index; break; }
    }
    const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
    const matches = [];
    for (let index = start + 1; index < end; index++) if (keyPattern.test(lines[index])) matches.push(index);
    if (matches.length > 1) {
      notes.push(`${label}: duplicate ${key} keys in [${section}] — left untouched.`);
      return false;
    }
    if (!matches.length) {
      lines.splice(end, 0, `${key} = ${value}`);
    } else {
      const index = matches[0];
      const valid = lines[index].match(new RegExp(`^(\\s*${escapeRegex(key)}\\s*=\\s*)(true|false)(\\s*(?:#.*)?)$`));
      if (!valid) {
        notes.push(`${label}: ${key} is not a boolean — left untouched.`);
        return false;
      }
      lines[index] = `${valid[1]}${value}${valid[3]}`;
    }
  }

  return write(file, bom + lines.join(newline) + newline, { backup });
}

function patchGrokConfig(file) {
  const raw = (read(file) || Buffer.from('')).toString('utf8');
  const targets = [
    ['memory', 'enabled'],
    ['compat.claude', 'agents'],
    ['compat.claude', 'hooks'],
    ['compat.cursor', 'hooks'],
  ];
  if (!targets.every(([section, key]) => tomlBooleanIsUnambiguous(raw, section, key))) {
    notes.push('Grok: ambiguous managed TOML — config left untouched.');
    return;
  }
  let wrote = false;
  for (const [section, key] of targets) {
    // Grok owns one native lifecycle adapter. Imported harness hooks would run
    // the same sync repeatedly; the first actual write keeps the sole backup.
    wrote = setTomlBoolean(file, section, key, 'false', 'Grok', !wrote) || wrote;
  }
}

function patchCodexConfig(file) {
  const raw = (read(file) || Buffer.from('')).toString('utf8');
  const targets = [
    ['features', 'hooks', 'true'],
    ['features', 'memories', 'false'],
    ['memories', 'generate_memories', 'false'],
    ['memories', 'use_memories', 'false'],
  ];
  if (!targets.every(([section, key]) => tomlBooleanIsUnambiguous(raw, section, key))) {
    notes.push('Codex: ambiguous managed TOML — config left untouched.');
    return;
  }
  let wrote = false;
  for (const [section, key, value] of targets) {
    wrote = setTomlBoolean(file, section, key, value, 'Codex', !wrote) || wrote;
  }
}

function patchCursorHooks(file) {
  if (UNINSTALL && !fs.existsSync(file)) return;
  const config = readJson(file, { version: 1, hooks: {} });
  if (config === null) return;
  config.version = config.version || 1;
  config.hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks
    : {};
  for (const [event, entries] of Object.entries(config.hooks)) {
    if (!Array.isArray(entries)) continue;
    config.hooks[event] = entries.filter((entry) => !hasOurHook(entry?.command));
    if (!config.hooks[event].length) delete config.hooks[event];
  }
  if (!UNINSTALL) {
    const managed = {
      sessionStart: { command: `${COMMAND} --cursor-context-hook`, timeout: 30 },
      afterAgentResponse: { command: `${COMMAND} --cursor-session-end`, timeout: 30 },
    };
    for (const [event, hook] of Object.entries(managed)) {
      config.hooks[event] = [
        ...(Array.isArray(config.hooks[event]) ? config.hooks[event] : []),
        hook,
      ];
    }
  }
  if (write(file, JSON.stringify(config, null, 2) + '\n', { backup: true })) {
    log(`${UNINSTALL ? 'unregistered' : 'registered'} Cursor hook`);
  }
}

function removeManagedKimiBlocks(raw) {
  const withoutMarked = String(raw || '').replace(
    /\n?# AI-MEMORY:KIMI-HOOKS:START[\s\S]*?# AI-MEMORY:KIMI-HOOKS:END\n?/g,
    '\n'
  );
  const lines = withoutMarked.split(/\r?\n/);
  const kept = [];
  let atRoot = true;
  for (let index = 0; index < lines.length;) {
    if (atRoot && /^\s*hooks\s*=\s*\[\s*\]\s*(?:#.*)?$/.test(lines[index])) {
      index++;
      continue;
    }
    if (!/^\s*\[\[hooks\]\]\s*(?:#.*)?$/.test(lines[index])) {
      if (/^\s*\[/.test(lines[index])) atRoot = false;
      kept.push(lines[index++]);
      continue;
    }
    const block = [lines[index++]];
    while (index < lines.length && !/^\s*\[/.test(lines[index])) block.push(lines[index++]);
    if (!block.join('\n').includes('.ai-memory/sync.js')) kept.push(...block);
  }
  return kept.join('\n').replace(/\s+$/, '');
}

function patchKimiHooks(file) {
  const existing = read(file);
  if (!existing && UNINSTALL) return;
  const raw = existing ? existing.toString('utf8') : '';
  const lines = raw.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootLines = firstTable < 0 ? lines : lines.slice(0, firstTable);
  const rootHooks = rootLines.filter((line) => /^\s*hooks\s*=/.test(line));
  if (rootHooks.some((line) => !/^\s*hooks\s*=\s*\[\s*\]\s*(?:#.*)?$/.test(line))) {
    notes.push('Kimi: non-empty inline hooks value is ambiguous — config left untouched.');
    return;
  }
  let next = removeManagedKimiBlocks(raw);
  if (!UNINSTALL) {
    const hooks = [
      ['SessionStart', 'startup|resume', `${COMMAND} --kimi-hook`, 30],
      ['SessionEnd', 'exit', `${COMMAND} --kimi-hook`, 4],
    ].map(([event, matcher, command, timeout]) => [
      '[[hooks]]',
      `event = ${JSON.stringify(event)}`,
      `matcher = ${JSON.stringify(matcher)}`,
      `command = ${JSON.stringify(command)}`,
      `timeout = ${timeout}`,
    ].join('\n')).join('\n\n');
    // SessionStart recovers a prior crashed session; SessionEnd updates the
    // current pointer without copying prompt or assistant text.
    const marked = `# AI-MEMORY:KIMI-HOOKS:START\n${hooks}\n# AI-MEMORY:KIMI-HOOKS:END`;
    next = `${next}${next ? '\n\n' : ''}${marked}`;
  }
  if (write(file, `${next}\n`, { backup: true })) {
    log(`${UNINSTALL ? 'unregistered' : 'registered'} Kimi hooks`);
  }
}

function patchZcodeMemory(file) {
  const config = readJson(file, {});
  if (config === null || UNINSTALL) return;
  if (config.memoryEnabled === false) return;
  config.memoryEnabled = false;
  if (write(file, JSON.stringify(config, null, 2) + '\n', { backup: true })) {
    log('disabled ZCode native Memory; existing memory data was preserved');
  }
}

function patchZcodeHooks(file) {
  if (UNINSTALL && !fs.existsSync(file)) return;
  const config = readJson(file, {});
  if (config === null) return;
  config.hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks
    : {};
  config.hooks.events = config.hooks.events && typeof config.hooks.events === 'object' && !Array.isArray(config.hooks.events)
    ? config.hooks.events
    : {};

  const managed = (hook) => Array.isArray(hook?.args) && hook.args.some((arg) => {
    const value = String(arg).replace(/\\/g, '/');
    return value.includes('/.ai-memory/sync.js') || value.includes('/.ai-memory/zcode-session-hook.js');
  });
  for (const [event, groups] of Object.entries(config.hooks.events)) {
    if (!Array.isArray(groups)) continue;
    config.hooks.events[event] = groups.flatMap((group) => {
      if (!group || !Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter((hook) => !managed(hook));
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!config.hooks.events[event].length) delete config.hooks.events[event];
  }

  if (!UNINSTALL) {
    const node = process.execPath.replace(/\\/g, '/');
    const start = {
      matcher: 'startup|resume|clear|compact',
      hooks: [{
        type: 'process',
        command: node,
        args: [path.join(AIMEM, 'sync.js').replace(/\\/g, '/')],
        timeoutMs: 60000,
        statusMessage: 'Syncing shared AI memory',
      }],
    };
    const stop = {
      hooks: [{
        type: 'process',
        command: node,
        args: [path.join(AIMEM, 'zcode-session-hook.js').replace(/\\/g, '/')],
        timeoutMs: 60000,
        statusMessage: 'Saving shared session memory',
      }],
    };
    config.hooks.enabled = true;
    config.hooks.events.SessionStart = [...(config.hooks.events.SessionStart || []), start];
    config.hooks.events.Stop = [...(config.hooks.events.Stop || []), stop];
  }

  if (write(file, JSON.stringify(config, null, 2) + '\n', { backup: true })) {
    log(`${UNINSTALL ? 'unregistered' : 'registered'} ZCode hooks`);
  }
}

function installKimiDesktopPlugin() {
  if (!fs.existsSync(KIMI_DESKTOP_RUNNER) || !fs.existsSync(KIMI_DESKTOP_HOME)) return;
  const source = path.join(AIMEM, 'kimi-desktop-plugin');
  if (CHECK) {
    const destination = path.join(KIMI_DESKTOP_HOME, 'plugins', 'managed', 'ai-memory');
    for (const file of ['kimi.plugin.json', 'hook.cjs']) {
      const wanted = read(path.join(source, file));
      const current = read(path.join(destination, file));
      if (!wanted || !current || !wanted.equals(current)) { changed++; break; }
    }
    return;
  }
  const result = spawnSync(process.execPath, [
    KIMI_DESKTOP_RUNNER,
    'kimi-plugin',
    'install',
    path.resolve(source),
    '--home',
    KIMI_DESKTOP_HOME,
    '--json',
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.status === 0) log('installed Kimi Desktop native lifecycle plugin');
  else notes.push(`Kimi Desktop plugin install failed (exit ${result.status ?? 'unknown'}).`);
}

function uninstallKimiDesktopPlugin() {
  const managedRoot = path.join(KIMI_DESKTOP_HOME, 'plugins', 'managed');
  const destination = path.join(managedRoot, 'ai-memory');
  if (!fs.existsSync(destination)) return;

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(destination, 'kimi.plugin.json'), 'utf8')); }
  catch {
    notes.push('Kimi Desktop ai-memory plugin has no valid manifest — left untouched.');
    return;
  }
  if (manifest.name !== 'ai-memory' || fs.lstatSync(destination).isSymbolicLink()) {
    notes.push('Kimi Desktop ai-memory plugin ownership could not be verified — left untouched.');
    return;
  }
  if (CHECK) { console.log(`  - ${destination}`); changed++; return; }
  fs.rmSync(destination, { recursive: true, force: true });
  changed++;
  log('removed Kimi Desktop native lifecycle plugin');
}

// ---------------------------------------------------------------------------
log(CHECK ? 'installer dry run — nothing will be written' : `${UNINSTALL ? 'uninstalling from' : 'installing to'} ${HOME}`);

if (UNINSTALL) {
  patchSettings(path.join(CLAUDE, 'settings.json'), 30, '~/.claude/settings.json', CLAUDE_EVENTS);
  if (fs.existsSync(CODEX)) patchSettings(path.join(CODEX, 'hooks.json'), 30, '~/.codex/hooks.json', CLAUDE_EVENTS);
  if (fs.existsSync(CURSOR)) patchCursorHooks(path.join(CURSOR, 'hooks.json'));
  if (fs.existsSync(KIMI)) patchKimiHooks(path.join(KIMI, 'config.toml'));
  if (fs.existsSync(ZCODE)) patchZcodeHooks(path.join(ZCODE, 'cli', 'config.json'));
  uninstallKimiDesktopPlugin();
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
for (const f of ['sync.js', 'sync-claude-to-codex.js', 'codex-notify.js', 'doctor.js', 'zcode-session-hook.js', 'platform-paths-(C).js']) {
  write(path.join(AIMEM, f), fs.readFileSync(path.join(REPO, 'src', f)));
}
for (const f of ['kimi.plugin.json', 'hook.cjs']) {
  write(path.join(AIMEM, 'kimi-desktop-plugin', f), fs.readFileSync(path.join(REPO, 'src', 'kimi-desktop-plugin', f)));
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
  patchCodexConfig(path.join(CODEX, 'config.toml'));
} else {
  notes.push('Codex not found — skipped. Install it and run this again.');
}

if (fs.existsSync(GROK)) {
  const hooks = { hooks: Object.fromEntries(GROK_EVENTS.map((ev) => [ev, [{ hooks: [{ type: 'command', command: COMMAND, timeout: 30 }] }]])) };
  write(path.join(GROK, 'hooks', 'ai-memory.json'), JSON.stringify(hooks, null, 2) + '\n', { backup: true });
  patchGrokConfig(path.join(GROK, 'config.toml'));
} else {
  notes.push('Grok not found — skipped.');
}

if (fs.existsSync(CURSOR)) patchCursorHooks(path.join(CURSOR, 'hooks.json'));
else notes.push('Cursor not found — skipped. Install it and run this again.');

if (fs.existsSync(KIMI)) patchKimiHooks(path.join(KIMI, 'config.toml'));
else notes.push('Kimi not found — skipped. Install it and run this again.');

installKimiDesktopPlugin();

if (fs.existsSync(ZCODE)) {
  patchZcodeHooks(path.join(ZCODE, 'cli', 'config.json'));
  patchZcodeMemory(path.join(ZCODE, 'v2', 'setting.json'));
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
log(CHECK
  ? `installer dry run: ${changed} installer-owned change(s) would be made; run --doctor for generated-package drift`
  : `done — ${changed} file(s) changed`);
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
