#!/usr/bin/env node
'use strict';
/**
 * ai-memory sync — one shared package for Claude Code, Codex, Grok, Kimi,
 * Cursor and ZCode.
 *
 * Home-instruktioner er BYTE-IDENTISKE i:
 *   ~/.claude/CLAUDE.md
 *   ~/.codex/AGENTS.md
 *   ~/.grok/rules/00-ai-memory.md
 *
 * Indhold (i rækkefølge):
 *   INSTRUCTIONS  ← ~/.ai-memory/INSTRUCTIONS.md
 *   DURABLE       ← ~/.ai-memory/MEMORY.md
 *   SESSIONS      ← seneste metadata-resuméer fra alle understøttede værktøjer
 *   CLAUDE-MEMORY-MAP ← index over ~/.claude/projects/<projekt>/memory/
 *
 * Plus: Codex/Grok/Kimi/Cursor session-import til ~/.claude/session-data/, og bridge
 * (skills/agents/commands/projekt-AGENTS) via sync-claude-to-codex.js.
 *
 * Kør manuelt:  node ~/.ai-memory/sync.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { appDataRoot } = require('./platform-paths-(C)');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const MEM_HOME = path.join(HOME, '.ai-memory');
const CANON = path.join(MEM_HOME, 'MEMORY.md');
const INSTRUCTIONS = path.join(MEM_HOME, 'INSTRUCTIONS.md');
const CONTEXT = path.join(MEM_HOME, 'CONTEXT.md');
const CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');
const CODEX_AGENTS = path.join(HOME, '.codex', 'AGENTS.md');
const CODEX_HOOKS = path.join(HOME, '.codex', 'hooks.json');
// Grok home-rules (altid loaded). Undgå dobbelt home-pakke og lifecycle via
// [compat.claude] agents/hooks = false og [compat.cursor] hooks = false.
const GROK_RULES = path.join(HOME, '.grok', 'rules', '00-ai-memory.md');
const KIMI_AGENTS = path.join(HOME, '.agents', 'AGENTS.md');
const CURSOR_RULES = path.join(HOME, '.cursorrules');
const CURSOR_GLOBAL_MDC = path.join(HOME, '.cursor', 'rules', '00-ai-memory.mdc');
const ZCODE_HOME = path.join(HOME, '.zcode');
const ZCODE_AGENTS = path.join(ZCODE_HOME, 'AGENTS.md');
const SESSION_STORE = path.join(HOME, '.claude', 'session-data');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const GROK_SESSIONS = path.join(HOME, '.grok', 'sessions');
const KIMI_HOME = path.join(HOME, '.kimi');
const KIMI_SESSIONS = path.join(KIMI_HOME, 'sessions');
const KIMI_META = path.join(KIMI_HOME, 'kimi.json');
const CURSOR_SESSIONS = path.join(HOME, '.cursor', 'projects');

// Kimi Desktop runs its embedded CLI with a private HOME. The public Kimi CLI
// uses ~/.agents directly; these extra targets are conditional and harmless.
const APPDATA = appDataRoot(HOME);
const KIMI_DESKTOP_ROOT = path.join(APPDATA, 'kimi-desktop', 'daimon-share', 'daimon');
const KIMI_PRIVATE_HOME = path.join(KIMI_DESKTOP_ROOT, 'runtime', 'kimi-code', 'home');
const KIMI_PRIVATE_AGENTS = path.join(KIMI_PRIVATE_HOME, '.agents', 'AGENTS.md');
const KIMI_WORKSPACE_START = '<!-- AI-MEMORY:KIMI-WORKSPACE:START -->';
const KIMI_WORKSPACE_END = '<!-- AI-MEMORY:KIMI-WORKSPACE:END -->';
// The source directory may itself be a Syncthing-backed vault. Import
// watermarks must be machine-local or one computer can cause another to skip
// its own older session files.
const RUNTIME_HOME = path.join(HOME, '.ai-memory-runtime');
const STATE_FILE = path.join(RUNTIME_HOME, 'sync-state.json');
const LEGACY_STATE_FILE = path.join(MEM_HOME, '.sync-state.json');
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');

function kimiDesktopWorkspace() {
  try {
    const config = JSON.parse(readSafe(path.join(KIMI_DESKTOP_ROOT, 'config.json')));
    const name = config?.agents?.default || 'main';
    const workDir = config?.agents?.entries?.[name]?.workDir;
    return workDir && fs.existsSync(workDir) ? path.join(workDir, 'AGENTS.md') : '';
  } catch { return ''; }
}

/** Every installed harness receives byte-identical home instructions. */
const HOME_TARGETS = [CLAUDE_MD, CODEX_AGENTS, GROK_RULES, KIMI_AGENTS, CURSOR_RULES];
if (fs.existsSync(ZCODE_HOME)) HOME_TARGETS.push(ZCODE_AGENTS);
if (fs.existsSync(KIMI_PRIVATE_HOME)) HOME_TARGETS.push(KIMI_PRIVATE_AGENTS);
const KIMI_WORKSPACE = kimiDesktopWorkspace();

const MAP_HINT_BULLETS = 4;
const MAP_HINT_CHARS = 110;
const IMPORT_MAX_AGE_DAYS = 14;
const IMPORT_MAX_FILES = 25;
const EXPORT_RECENT = 12;
const SESSION_TEXT_LIMIT = 200;

function oldestPendingBatch(items, lastImport, cutoff, limit = IMPORT_MAX_FILES) {
  return items
    .filter((item) => item.mtime > lastImport && item.mtime >= cutoff)
    .sort((a, b) => a.mtime - b.mtime)
    .slice(0, limit);
}

function completedBatchWatermark(lastImport, items, failed) {
  if (failed) return lastImport;
  return items.reduce((latest, item) => Math.max(latest, item.mtime), lastImport);
}

function log(msg) { process.stderr.write(`[ai-memory] ${msg}\n`); }
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function parseState(file) {
  try { return JSON.parse(readSafe(file)) || {}; } catch { return {}; }
}

function loadState() {
  const local = parseState(STATE_FILE);
  if (Object.keys(local).length) return local;
  // One-time compatibility path for installations that kept ai-memory inside a
  // synced vault before runtime state was made local. Leave the old file alone:
  // it may be the only recovery copy until both machines have upgraded.
  const legacy = parseState(LEGACY_STATE_FILE);
  if (Object.keys(legacy).length) log('migrerer tidligere shared sync-state til maskinlokal runtime-state');
  return legacy;
}
function saveState(s) {
  try {
    ensureDir(RUNTIME_HOME);
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function managedBlock(tag, body, editHint) {
  const hint = editHint || 'MEMORY.md';
  const start = `<!-- AI-MEMORY:${tag}:START (auto-genereret af ~/.ai-memory/sync.js — redigér ${hint}, ikke her) -->`;
  const end = `<!-- AI-MEMORY:${tag}:END -->`;
  return `${start}\n${(body || '').trim()}\n${end}`;
}

function normalizeNewlines(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
}

function writeIfChanged(file, content) {
  const next = normalizeNewlines(content);
  const cur = normalizeNewlines(readSafe(file));
  if (cur === next) return false;
  ensureDir(path.dirname(file));
  try {
    fs.writeFileSync(file, next, 'utf8');
    log(`wrote → ${file}`);
    return true;
  } catch (e) {
    log(`WARN could not write ${file}: ${e.message}`);
    return false;
  }
}

/** Keep Kimi project rules and own only one bounded block in its AGENTS.md. */
function writeKimiWorkspace(pkg, previousCanonical) {
  if (!KIMI_WORKSPACE) return false;
  const current = readSafe(KIMI_WORKSPACE);
  const starts = current.split(KIMI_WORKSPACE_START).length - 1;
  const ends = current.split(KIMI_WORKSPACE_END).length - 1;
  if (starts !== ends || starts > 1) {
    log(`WARN malformed Kimi workspace block left untouched: ${KIMI_WORKSPACE}`);
    return false;
  }

  let projectRules = current.trim();
  if (starts === 1) {
    const start = current.indexOf(KIMI_WORKSPACE_START);
    const end = current.indexOf(KIMI_WORKSPACE_END, start);
    projectRules = `${current.slice(0, start)}${current.slice(end + KIMI_WORKSPACE_END.length)}`.trim();
  } else if (
    normalizeNewlines(current) === normalizeNewlines(pkg) ||
    (previousCanonical && normalizeNewlines(current) === normalizeNewlines(previousCanonical))
  ) {
    // Migrate the previous version's whole-file target without duplicating it.
    projectRules = '';
  }

  const managed = `${KIMI_WORKSPACE_START}\n${pkg.trim()}\n${KIMI_WORKSPACE_END}`;
  return writeIfChanged(KIMI_WORKSPACE, projectRules ? `${projectRules}\n\n${managed}` : managed);
}

function isManagedHook(command) {
  return String(command || '').replace(/\\/g, '/').includes('/.ai-memory/sync.js');
}

/** Codex hooks are also reconciled on every sync so app updates cannot drift. */
function ensureCodexHooks() {
  let config = { hooks: {} };
  if (fs.existsSync(CODEX_HOOKS)) {
    try {
      config = JSON.parse(readSafe(CODEX_HOOKS));
      if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('root is not an object');
    } catch (error) {
      log(`WARN invalid Codex hooks.json left untouched: ${error.message}`);
      return false;
    }
  }

  const hooks = config.hooks && !Array.isArray(config.hooks) && typeof config.hooks === 'object'
    ? { ...config.hooks }
    : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups.flatMap((group) => {
      if (!group || !Array.isArray(group.hooks)) return [group];
      const remaining = group.hooks.filter((handler) => !isManagedHook(handler?.command));
      return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    if (!hooks[event].length) delete hooks[event];
  }

  const script = path.join(MEM_HOME, 'sync.js').replace(/\\/g, '/');
  const syncCommand = `"${process.execPath.replace(/\\/g, '/')}" "${script}"`;
  const contextCommand = `${syncCommand} --codex-context-hook`;
  const finishCommand = `${syncCommand} --codex-session-end`;
  const managed = {
    SessionStart: {
      matcher: 'startup|resume|clear|compact',
      hooks: [{ type: 'command', command: syncCommand, timeout: 30, statusMessage: 'Syncing shared AI memory' }],
    },
    UserPromptSubmit: {
      hooks: [{ type: 'command', command: contextCommand, timeout: 10, additionalContextLimit: 5000 }],
    },
    SubagentStart: {
      hooks: [{ type: 'command', command: contextCommand, timeout: 10, additionalContextLimit: 5000 }],
    },
    Stop: {
      hooks: [{ type: 'command', command: finishCommand, timeout: 30, statusMessage: 'Saving shared session memory' }],
    },
    SessionEnd: {
      hooks: [{ type: 'command', command: finishCommand, timeout: 3, statusMessage: 'Saving shared session memory' }],
    },
  };
  for (const [event, group] of Object.entries(managed)) {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), group];
  }

  config.hooks = hooks;
  return writeIfChanged(CODEX_HOOKS, JSON.stringify(config, null, 2));
}

const ADHD_CONTEXT = [
  'OUTPUT FORM (always on for an ADHD reader):',
  '1. Put the next action in the first line; no introduction.',
  '2. Number multi-step work; one bounded action per step.',
  '3. Use at most five bullets per list and short text blocks.',
  '4. State current status and finish with one next step under two minutes.',
].join('\n');

function readHookEvent() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); }
  catch { return {}; }
}

/** Optional project matcher beside a junctioned vault source. */
function projectContext(prompt) {
  const text = String(prompt || '').trim();
  if (text.length < 15 || text.startsWith('/')) return '';

  let physical;
  try { physical = fs.realpathSync(MEM_HOME); } catch { return ''; }
  const logical = path.resolve(MEM_HOME);
  const same = process.platform === 'win32'
    ? physical.toLowerCase() === logical.toLowerCase()
    : physical === logical;
  if (same) return '';

  const matcher = path.join(path.dirname(physical), 'scheduled', 'project-matcher.py');
  if (!fs.existsSync(matcher)) return '';
  const candidates = process.env.AI_MEMORY_PYTHON
    ? [[process.env.AI_MEMORY_PYTHON, []]]
    : process.platform === 'win32'
      ? [['py', ['-3', '-X', 'utf8']], ['python', ['-X', 'utf8']]]
      : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [
      ...prefix,
      matcher,
      '--prompt', text.slice(0, 1000),
      '--inject',
      '--no-log',
    ], { encoding: 'utf8', timeout: 9000, windowsHide: true });
    if (result.status === 0) return String(result.stdout || '').trim().slice(0, 4500);
    if (result.error?.code === 'ENOENT') continue;
    log(`WARN optional project matcher failed: ${result.error?.message || `exit ${result.status}`}`);
    return '';
  }
  return '';
}

function runCodexContextHook() {
  const event = readHookEvent();
  if (event.hook_event_name !== 'UserPromptSubmit' && event.hook_event_name !== 'SubagentStart') return;
  const context = [
    ADHD_CONTEXT,
    ...(event.hook_event_name === 'UserPromptSubmit' ? [projectContext(event.prompt || event.user_prompt)] : []),
  ].filter(Boolean).join('\n\n');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event.hook_event_name,
      additionalContext: context,
    },
  }));
}

/** Kimi appends successful hook stdout directly to the model context. */
function runKimiContextHook() {
  process.stdout.write(ADHD_CONTEXT);
}

/** Cursor sessionStart refreshes the package before injecting its context. */
function runCursorContextHook() {
  main();
  process.stdout.write(JSON.stringify({ additional_context: ADHD_CONTEXT }));
}

function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function timeStr(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// ---------------------------------------------------------------------------
// Home-pakke: INSTRUCTIONS + DURABLE + SESSIONS + MAP (byte-identisk)
// ---------------------------------------------------------------------------
function buildSessionsBody() {
  let files = [];
  try {
    files = fs.readdirSync(SESSION_STORE)
      .filter(n => n.endsWith('-session.tmp'))
      .map(n => { const fp = path.join(SESSION_STORE, n); return { fp, m: fs.statSync(fp).mtimeMs }; })
      .sort((a, b) => b.m - a.m)
      .slice(0, EXPORT_RECENT);
  } catch { /* ingen store endnu */ }

  if (!files.length) return '_Ingen tidligere sessions endnu._';

  const lines = ['## Recent sessions (metadata only — prompt text is never injected)', ''];
  for (const { fp } of files) {
    const c = readSafe(fp);
    const proj = field(c, 'Project') || '?';
    const date = field(c, 'Date') || '';
    const src = field(c, 'Source') || 'Claude';
    lines.push(`- ${proj} (${date}, ${src})`);
  }
  return lines.join('\n');
}

function memoryIndexHints(index) {
  return String(index || '').split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*] /.test(line))
    .slice(0, MAP_HINT_BULLETS)
    .map((line) => {
      const value = line.replace(/^[-*]\s*/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
      const clipped = value.length > MAP_HINT_CHARS ? `${value.slice(0, MAP_HINT_CHARS).trimEnd()}…` : value;
      return `  - ${clipped}`;
    });
}

function buildMemoryMapBody() {
  let slugs;
  try {
    slugs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch { return '_Ingen Claude projekt-memory fundet._'; }

  const sections = [];
  for (const slug of slugs) {
    const memDir = path.join(CLAUDE_PROJECTS, slug, 'memory');
    let files;
    try { files = fs.readdirSync(memDir).filter(n => n.toLowerCase().endsWith('.md')); }
    catch { continue; }
    if (!files.length) continue;

    const hints = memoryIndexHints(readSafe(path.join(memDir, 'MEMORY.md')));
    sections.push([
      `- **${slug}** — ${files.length} files in \`${memDir}\``,
      ...hints,
    ].join('\n'));
  }
  if (!sections.length) return '_Ingen Claude projekt-memory fundet._';

  return [
    '## Claude project memory (pointer map)',
    'The full files remain on the same disk. Read the relevant MEMORY.md and detail file when a project matches.',
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n');
}

function buildHomePackage() {
  const instructions = readSafe(INSTRUCTIONS).trim() ||
    '_Mangler ~/.ai-memory/INSTRUCTIONS.md_';
  const durable = readSafe(CANON).trim() ||
    '_Mangler ~/.ai-memory/MEMORY.md_';
  // CONTEXT er valgfri: findes den ikke, udelades blokken helt i stedet for at
  // skrive en "mangler"-linje ind i pakken på maskiner der ikke har den endnu.
  const context = readSafe(CONTEXT).trim();
  const sessions = buildSessionsBody();
  const map = buildMemoryMapBody();

  return [
    '# Shared AI package (Claude Code + Codex + Grok + Kimi + Cursor + ZCode)',
    '',
    '> **100% ens home-instruktioner.** Auto-genereret af `~/.ai-memory/sync.js`.',
    '> Redigér kun `~/.ai-memory/INSTRUCTIONS.md` (adfærd), `~/.ai-memory/CONTEXT.md` (forretningskontekst) og `~/.ai-memory/MEMORY.md` (holdbare fakta).',
    '> The same bytes are written to Claude Code, Codex, Grok, Kimi, Cursor and installed ZCode targets.',
    '',
    managedBlock('INSTRUCTIONS', instructions, 'INSTRUCTIONS.md'),
    '',
    ...(context ? [managedBlock('CONTEXT', context, 'CONTEXT.md'), ''] : []),
    managedBlock('DURABLE', durable, 'MEMORY.md'),
    '',
    managedBlock('SESSIONS', sessions, 'session-data (auto)'),
    '',
    managedBlock('CLAUDE-MEMORY-MAP', map, 'projects/*/memory (auto)'),
    '',
  ].join('\n');
}

function writeHomePackage() {
  const pkg = buildHomePackage();
  const previousCanonical = readSafe(CLAUDE_MD);
  let n = 0;
  for (const file of HOME_TARGETS) {
    if (writeIfChanged(file, pkg)) n++;
  }
  const frontmatter = '---\ndescription: Shared AI instructions and memory\nalwaysApply: true\n---\n\n';
  if (writeIfChanged(CURSOR_GLOBAL_MDC, frontmatter + pkg)) n++;
  if (writeKimiWorkspace(pkg, previousCanonical)) n++;
  bridgeKimiDesktopSkills();
  const targetCount = HOME_TARGETS.length + 1 + (KIMI_WORKSPACE ? 1 : 0);
  if (!n) log(`home-pakke allerede identisk på alle ${targetCount} targets`);
  else log(`home-pakke opdateret på ${n}/${targetCount} targets`);
}

function bridgeKimiDesktopSkills() {
  if (!fs.existsSync(KIMI_PRIVATE_HOME)) return;
  const source = path.join(HOME, '.agents', 'skills');
  const destination = path.join(KIMI_PRIVATE_HOME, '.agents', 'skills');
  if (!fs.existsSync(source) || fs.existsSync(destination)) return;
  try {
    ensureDir(path.dirname(destination));
    fs.symlinkSync(source, destination, 'junction');
    log('linked shared skills into Kimi Desktop');
  } catch (error) {
    log(`WARN could not link Kimi Desktop skills: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 2) IMPORT: Codex-rollouts -> ECC *-session.tmp i delt store
// ---------------------------------------------------------------------------
function listCodexRollouts() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /^rollout-.*\.jsonl$/i.test(e.name)) {
        try { out.push({ path: full, mtime: fs.statSync(full).mtimeMs }); } catch {}
      }
    }
  };
  walk(CODEX_SESSIONS);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Fjern produkt-wrappere, så session-recall kun viser brugerens egen opgave. */
function cleanCodexUserText(value) {
  return value
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, ' ')
    .replace(/# AGENTS\.md instructions[\s\S]*$/i, ' ')
    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeCodexRollout(file) {
  const raw = readSafe(file);
  if (!raw) return null;
  const lines = raw.split('\n').filter(Boolean);
  let cwd = '', id = '', ts = '';
  const userMsgs = [];
  const tools = new Set();
  const files = new Set();

  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const p = j.payload || {};
    if (j.type === 'session_meta') {
      cwd = p.cwd || cwd; id = p.id || id; ts = p.timestamp || ts;
      continue;
    }
    if (j.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'user') {
      const text = cleanCodexUserText((Array.isArray(p.content) ? p.content : [])
        .filter(c => c && (c.type === 'input_text' || c.type === 'text' || c.type === 'output_text'))
        .map(c => c.text || '').join(' '));
      // spring system/permissions-wrappere over
      if (text && !/^<(permissions|user_instructions|environment_context)/i.test(text)) {
        userMsgs.push(text.slice(0, 200));
      }
    } else if (p.type === 'function_call') {
      if (p.name) tools.add(p.name);
      const args = typeof p.arguments === 'string' ? p.arguments : '';
      const m = args.match(/[A-Za-z]:\\\\[^"'\s]+|\/[^"'\s]+\.[A-Za-z0-9]+/);
      if (m && (p.name === 'apply_patch' || /patch|write|edit/i.test(p.name))) files.add(m[0]);
    }
  }

  if (!cwd || userMsgs.length === 0) return null;
  return {
    cwd, id, ts,
    userMsgs: userMsgs.slice(-10),
    tools: Array.from(tools).slice(0, 20),
    files: Array.from(files).slice(0, 30),
    total: userMsgs.length,
  };
}

function buildCodexSessionTmp(s, when) {
  const project = s.cwd ? path.basename(s.cwd.replace(/[\\/]+$/, '')) : 'unknown';
  const L = [];
  L.push(`# Session (Codex): ${dateStr(when)}`);
  L.push(`**Date:** ${dateStr(when)}`);
  L.push(`**Started:** ${timeStr(when)}`);
  L.push(`**Last Updated:** ${timeStr(when)}`);
  L.push(`**Project:** ${project}`);
  L.push(`**Branch:** unknown`);
  L.push(`**Worktree:** ${s.cwd}`);
  L.push(`**Source:** Codex`);
  L.push('');
  L.push('---');
  L.push('<!-- ECC:SUMMARY:START -->');
  L.push('## Session Summary (Codex)');
  L.push('');
  L.push('### Tasks');
  for (const m of s.userMsgs) L.push(`- ${m.replace(/`/g, '\\`')}`);
  L.push('');
  if (s.files.length) { L.push('### Files Touched'); for (const f of s.files) L.push(`- ${f}`); L.push(''); }
  if (s.tools.length) { L.push('### Tools Used'); L.push(s.tools.join(', ')); L.push(''); }
  L.push('### Stats');
  L.push(`- Source: Codex session ${s.id || '?'}`);
  L.push(`- Total user messages: ${s.total}`);
  L.push('<!-- ECC:SUMMARY:END -->');
  L.push('');
  return L.join('\n');
}

function importCodexSessions() {
  ensureDir(SESSION_STORE);
  const state = loadState();
  const lastImport = Number(state.lastCodexImport || 0);
  const cutoff = Date.now() - IMPORT_MAX_AGE_DAYS * 86400000;

  const rollouts = oldestPendingBatch(listCodexRollouts(), lastImport, cutoff);

  let imported = 0, failed = false;
  for (const r of rollouts) {
    const s = summarizeCodexRollout(r.path);
    if (!s) continue;
    const when = new Date(r.mtime);
    const short = (s.id || path.basename(r.path)).replace(/[^a-z0-9]/gi, '').slice(-8) || 'codex';
    const fname = `${dateStr(when)}-codex-${short}-session.tmp`;
    try {
      fs.writeFileSync(path.join(SESSION_STORE, fname), buildCodexSessionTmp(s, when));
      imported++;
    } catch (e) {
      log(`WARN write ${fname}: ${e.message}`);
      failed = true;
      break;
    }
  }
  state.lastCodexImport = completedBatchWatermark(lastImport, rollouts, failed);
  saveState(state);
  if (imported) log(`importerede ${imported} Codex-session(s) til delt store`);
  else log('ingen nye Codex-sessions at importere');
}

// ---------------------------------------------------------------------------
// 2b) IMPORT: Grok-sessions -> ECC *-session.tmp i delt store
// ---------------------------------------------------------------------------
function listGrokSummaries() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === 'summary.json') {
        try { out.push({ path: full, mtime: fs.statSync(full).mtimeMs }); } catch {}
      }
    }
  };
  walk(GROK_SESSIONS);
  return out.sort((a, b) => b.mtime - a.mtime);
}

function loadGrokPromptsForSession(sessionDir, sessionId) {
  const prompts = [];
  // Workspace-level prompt_history.jsonl (parent of session dir)
  const hist = path.join(path.dirname(sessionDir), 'prompt_history.jsonl');
  const raw = readSafe(hist);
  if (raw) {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.session_id === sessionId && j.prompt && !j.is_bash) {
        prompts.push(String(j.prompt).replace(/\s+/g, ' ').trim().slice(0, 200));
      }
    }
  }
  return prompts;
}

function summarizeGrokSession(summaryPath) {
  let s;
  try { s = JSON.parse(readSafe(summaryPath)); } catch { return null; }
  if (!s || !s.info) return null;
  const cwd = s.info.cwd || '';
  const id = s.info.id || path.basename(path.dirname(summaryPath));
  const sessionDir = path.dirname(summaryPath);
  let userMsgs = loadGrokPromptsForSession(sessionDir, id);
  const title = (s.generated_title || s.session_summary || '').trim();
  if (title && !userMsgs.some(m => m.includes(title.slice(0, 40)))) {
    userMsgs = [title, ...userMsgs];
  }
  if (!cwd || userMsgs.length === 0) return null;
  return {
    cwd,
    id,
    ts: s.updated_at || s.created_at || '',
    userMsgs: userMsgs.slice(-10),
    tools: [],
    files: [],
    total: userMsgs.length,
    title,
  };
}

function buildGrokSessionTmp(s, when) {
  const project = s.cwd ? path.basename(s.cwd.replace(/[\\/]+$/, '')) : 'unknown';
  const L = [];
  L.push(`# Session (Grok): ${dateStr(when)}`);
  L.push(`**Date:** ${dateStr(when)}`);
  L.push(`**Started:** ${timeStr(when)}`);
  L.push(`**Last Updated:** ${timeStr(when)}`);
  L.push(`**Project:** ${project}`);
  L.push(`**Branch:** unknown`);
  L.push(`**Worktree:** ${s.cwd}`);
  L.push(`**Source:** Grok`);
  L.push('');
  L.push('---');
  L.push('<!-- ECC:SUMMARY:START -->');
  L.push('## Session Summary (Grok)');
  L.push('');
  L.push('### Tasks');
  for (const m of s.userMsgs) L.push(`- ${m.replace(/`/g, '\\`')}`);
  L.push('');
  L.push('### Stats');
  L.push(`- Source: Grok session ${s.id || '?'}`);
  if (s.title) L.push(`- Title: ${s.title}`);
  L.push(`- Total user messages: ${s.total}`);
  L.push('<!-- ECC:SUMMARY:END -->');
  L.push('');
  return L.join('\n');
}

function importGrokSessions() {
  ensureDir(SESSION_STORE);
  const state = loadState();
  const lastImport = Number(state.lastGrokImport || 0);
  const cutoff = Date.now() - IMPORT_MAX_AGE_DAYS * 86400000;

  const summaries = oldestPendingBatch(listGrokSummaries(), lastImport, cutoff);

  let imported = 0, failed = false;
  for (const r of summaries) {
    const s = summarizeGrokSession(r.path);
    if (!s) continue;
    const when = new Date(s.ts || r.mtime);
    const short = (s.id || 'grok').replace(/[^a-z0-9]/gi, '').slice(-8) || 'grok';
    const fname = `${dateStr(when)}-grok-${short}-session.tmp`;
    try {
      fs.writeFileSync(path.join(SESSION_STORE, fname), buildGrokSessionTmp(s, when));
      imported++;
    } catch (e) {
      log(`WARN write ${fname}: ${e.message}`);
      failed = true;
      break;
    }
  }
  state.lastGrokImport = completedBatchWatermark(lastImport, summaries, failed);
  saveState(state);
  if (imported) log(`importerede ${imported} Grok-session(s) til delt store`);
  else log('ingen nye Grok-sessions at importere');
}

// ---------------------------------------------------------------------------
// 2c) IMPORT: Kimi sessions -> private shared session store
// ---------------------------------------------------------------------------
function kimiWorkDirs() {
  const result = new Map();
  try {
    const meta = JSON.parse(readSafe(KIMI_META));
    for (const item of Array.isArray(meta?.work_dirs) ? meta.work_dirs : []) {
      if (!item?.path) continue;
      const hash = crypto.createHash('md5').update(String(item.path)).digest('hex');
      result.set(hash.toLowerCase(), String(item.path));
    }
  } catch { /* Kimi may not have started yet */ }
  return result;
}

function listKimiWires() {
  const out = [];
  let workDirs;
  try { workDirs = fs.readdirSync(KIMI_SESSIONS, { withFileTypes: true }); }
  catch { return out; }
  const paths = kimiWorkDirs();
  for (const work of workDirs) {
    if (!work.isDirectory()) continue;
    const workRoot = path.join(KIMI_SESSIONS, work.name);
    let sessions;
    try { sessions = fs.readdirSync(workRoot, { withFileTypes: true }); }
    catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const file = path.join(workRoot, session.name, 'wire.jsonl');
      try {
        const stat = fs.statSync(file);
        out.push({
          path: file,
          mtime: stat.mtimeMs,
          id: session.name,
          cwd: paths.get(work.name.toLowerCase()) || work.name,
        });
      } catch { /* incomplete session */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function summarizeKimiWire(item) {
  let turns = 0;
  let timestamp = 0;
  for (const line of readSafe(item.path).split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.message?.type !== 'TurnBegin') continue;
    turns++;
    if (Number(record.timestamp) > timestamp) timestamp = Number(record.timestamp);
  }
  return {
    cwd: item.cwd,
    id: item.id,
    pointer: item.path,
    turns,
    timestamp: timestamp > 1e12 ? timestamp : timestamp * 1000,
  };
}

function buildKimiSessionTmp(session, when, runtime = 'CLI') {
  const project = session.cwd ? path.basename(String(session.cwd).replace(/[\\/]+$/, '')) : 'unknown';
  return [
    `# Session (Kimi ${runtime}): ${dateStr(when)}`,
    `**Date:** ${dateStr(when)}`,
    `**Started:** ${timeStr(when)}`,
    `**Last Updated:** ${timeStr(when)}`,
    `**Project:** ${project}`,
    '**Branch:** unknown',
    `**Worktree:** ${session.cwd}`,
    '**Source:** Kimi',
    `**Runtime:** ${runtime}`,
    `**Transcript:** ${session.pointer}`,
    '',
    '---',
    '<!-- ECC:SUMMARY:START -->',
    '## Session Summary (metadata only)',
    '',
    '### Stats',
    `- Source: Kimi session ${session.id || '?'}`,
    `- Runtime: ${runtime}`,
    `- Turns: ${session.turns || 0}`,
    '- Prompt and assistant text: not copied',
    '<!-- ECC:SUMMARY:END -->',
    '',
  ].join('\n');
}

function buildSimpleSessionTmp(source, session, when) {
  const project = session.cwd ? path.basename(String(session.cwd).replace(/[\\/]+$/, '')) : 'unknown';
  const lines = [
    `# Session (${source}): ${dateStr(when)}`,
    `**Date:** ${dateStr(when)}`,
    `**Started:** ${timeStr(when)}`,
    `**Last Updated:** ${timeStr(when)}`,
    `**Project:** ${project}`,
    '**Branch:** unknown',
    `**Worktree:** ${session.cwd}`,
    `**Source:** ${source}`,
    '',
    '---',
    '<!-- ECC:SUMMARY:START -->',
    `## Session Summary (${source})`,
    '',
    '### Tasks',
    ...session.userMsgs.map((message) => `- ${message.replace(/`/g, '\\`')}`),
    '',
    '### Stats',
    `- Source: ${source} session ${session.id || '?'}`,
    `- Total user messages: ${session.total}`,
    '<!-- ECC:SUMMARY:END -->',
    '',
  ];
  return lines.join('\n');
}

function importKimiSessions() {
  ensureDir(SESSION_STORE);
  const state = loadState();
  const lastImport = Number(state.lastKimiImport || 0);
  const cutoff = Date.now() - IMPORT_MAX_AGE_DAYS * 86400000;
  const wires = oldestPendingBatch(listKimiWires(), lastImport, cutoff);

  let imported = 0;
  let failed = false;
  for (const item of wires) {
    const session = summarizeKimiWire(item);
    if (!session) continue;
    const when = new Date(session.timestamp || item.mtime);
    const short = item.id.replace(/[^a-z0-9]/gi, '').slice(-8) || 'kimi';
    const filename = `${dateStr(when)}-kimi-${short}-session.tmp`;
    try {
      fs.writeFileSync(path.join(SESSION_STORE, filename), buildKimiSessionTmp(session, when));
      imported++;
    } catch (error) {
      log(`WARN write ${filename}: ${error.message}`);
      failed = true;
      break;
    }
  }
  state.lastKimiImport = completedBatchWatermark(lastImport, wires, failed);
  saveState(state);
  if (imported) log(`importerede ${imported} Kimi-session(s) til delt store`);
  else log('ingen nye Kimi-sessions at importere');
}

function countDesktopTurns(file) {
  let turns = 0;
  for (const line of readSafe(file).split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === 'turn.prompt' || record?.message?.type === 'turn.prompt') turns++;
    } catch { /* incomplete trailing record */ }
  }
  return turns;
}

function desktopSession(event) {
  const root = process.env.KIMI_CODE_HOME;
  const id = event.session_id || event.sessionId;
  if (!root || !id) return null;
  let match = null;
  for (const line of readSafe(path.join(root, 'session_index.jsonl')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.sessionId === id && !record.deleted) match = record;
    } catch { /* skip malformed index record */ }
  }
  const sessionDir = match?.sessionDir
    ? (path.isAbsolute(match.sessionDir) ? match.sessionDir : path.join(root, match.sessionDir))
    : '';
  const pointer = sessionDir ? path.join(sessionDir, 'agents', 'main', 'wire.jsonl') : '';
  return {
    id,
    cwd: match?.workDir || event.cwd || 'unknown',
    pointer,
    turns: pointer ? countDesktopTurns(pointer) : 0,
  };
}

function cliHookSession(event) {
  const id = event.session_id || event.sessionId;
  const cwd = event.cwd;
  if (!id || !cwd) return null;
  const hash = crypto.createHash('md5').update(String(cwd)).digest('hex');
  const pointer = path.join(KIMI_SESSIONS, hash, id, 'wire.jsonl');
  return summarizeKimiWire({ path: pointer, id, cwd }) || { id, cwd, pointer, turns: 0, timestamp: 0 };
}

function writeKimiHookSession(session, runtime) {
  if (!session) return false;
  ensureDir(SESSION_STORE);
  const when = new Date(session.timestamp || Date.now());
  const short = String(session.id || runtime).replace(/[^a-z0-9]/gi, '').slice(-8) || 'kimi';
  const filename = `${dateStr(when)}-kimi-${short}-session.tmp`;
  fs.writeFileSync(path.join(SESSION_STORE, filename), buildKimiSessionTmp(session, when, runtime));
  return true;
}

function runKimiHook() {
  const event = readHookEvent();
  const runtime = process.env.KIMI_CODE_HOME ? 'Desktop' : 'CLI';
  try {
    if (event.hook_event_name === 'SessionStart' && runtime === 'CLI') importKimiSessions();
    const session = runtime === 'Desktop' ? desktopSession(event) : cliHookSession(event);
    writeKimiHookSession(session, runtime);
    ensureDir(RUNTIME_HOME);
    fs.writeFileSync(path.join(RUNTIME_HOME, 'kimi-hook.json'), JSON.stringify({
      at: new Date().toISOString(),
      event: event.hook_event_name || 'unknown',
      runtime,
      sessionId: event.session_id || event.sessionId || '',
    }, null, 2));
    writeHomePackage();
  } catch (error) {
    // Hooks are continuity aids, not security gates. Fail open with no stdout.
    log(`WARN Kimi hook failed open: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 2d) IMPORT: Cursor transcripts -> private shared session store
// ---------------------------------------------------------------------------
function listCursorTranscripts() {
  const out = [];
  let projects;
  try { projects = fs.readdirSync(CURSOR_SESSIONS, { withFileTypes: true }); }
  catch { return out; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const transcripts = path.join(CURSOR_SESSIONS, project.name, 'agent-transcripts');
    let sessions;
    try { sessions = fs.readdirSync(transcripts, { withFileTypes: true }); }
    catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const file = path.join(transcripts, session.name, `${session.name}.jsonl`);
      try {
        out.push({
          path: file,
          id: session.name,
          project: project.name,
          mtime: fs.statSync(file).mtimeMs,
        });
      } catch { /* incomplete transcript */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function cursorProjectPath(slug) {
  if (!slug || slug === 'empty-window') return 'unknown';
  if (/^[a-z]-/i.test(slug)) return `${slug[0].toUpperCase()}:${slug.slice(1).replace(/-/g, path.sep)}`;
  return slug;
}

function summarizeCursorTranscript(item) {
  const prompts = [];
  for (const line of readSafe(item.path).split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.role !== 'user') continue;
    const content = Array.isArray(record?.message?.content) ? record.message.content : [];
    for (const part of content) {
      if (part?.type !== 'text' || !part.text) continue;
      const tagged = String(part.text).match(/<user_query>([\s\S]*?)<\/user_query>/i);
      const text = String(tagged ? tagged[1] : part.text)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text && !text.startsWith('You are the forked subagent')) prompts.push(text.slice(0, SESSION_TEXT_LIMIT));
    }
  }
  if (!prompts.length) return null;
  return {
    cwd: cursorProjectPath(item.project),
    id: item.id,
    userMsgs: prompts.slice(-10),
    total: prompts.length,
  };
}

function importCursorSessions() {
  ensureDir(SESSION_STORE);
  const state = loadState();
  const lastImport = Number(state.lastCursorImport || 0);
  const cutoff = Date.now() - IMPORT_MAX_AGE_DAYS * 86400000;
  const transcripts = oldestPendingBatch(listCursorTranscripts(), lastImport, cutoff);

  let imported = 0;
  let failed = false;
  for (const item of transcripts) {
    const session = summarizeCursorTranscript(item);
    if (!session) continue;
    const when = new Date(item.mtime);
    const short = item.id.replace(/[^a-z0-9]/gi, '').slice(-8) || 'cursor';
    const filename = `${dateStr(when)}-cursor-${short}-session.tmp`;
    try {
      fs.writeFileSync(path.join(SESSION_STORE, filename), buildSimpleSessionTmp('Cursor', session, when));
      imported++;
    } catch (error) {
      log(`WARN write ${filename}: ${error.message}`);
      failed = true;
      break;
    }
  }
  state.lastCursorImport = completedBatchWatermark(lastImport, transcripts, failed);
  saveState(state);
  if (imported) log(`importerede ${imported} Cursor-session(s) til delt store`);
  else log('ingen nye Cursor-sessions at importere');
}

// ---------------------------------------------------------------------------
// Helpers brugt af session-export i home-pakken
// ---------------------------------------------------------------------------
function field(content, label) {
  const m = content.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`));
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------------------
function main() {
  ensureDir(MEM_HOME);
  try { ensureCodexHooks(); } catch (e) { log(`Codex hooks error: ${e.message}`); }
  // Skills, agents, commands, projekt-AGENTS — før home-pakke, så inventar er frisk.
  try { require('./sync-claude-to-codex').main(); } catch (e) { log(`bridge fejl: ${e.message}`); }
  try { importCodexSessions(); } catch (e) { log(`import codex fejl: ${e.message}`); }
  try { importGrokSessions(); } catch (e) { log(`import grok fejl: ${e.message}`); }
  try { importKimiSessions(); } catch (e) { log(`import Kimi fejl: ${e.message}`); }
  try { importCursorSessions(); } catch (e) { log(`import Cursor fejl: ${e.message}`); }
  try { writeHomePackage(); } catch (e) { log(`home-pakke fejl: ${e.message}`); }
}

function finishSource(source) {
  if (source === 'codex') importCodexSessions();
  if (source === 'kimi') importKimiSessions();
  if (source === 'cursor') importCursorSessions();
  writeHomePackage();
}

switch (process.argv[2]) {
  case '--codex-hooks-only':
    ensureCodexHooks();
    break;
  case '--codex-context-hook':
    runCodexContextHook();
    break;
  case '--codex-session-end':
    finishSource('codex');
    break;
  case '--kimi-context-hook':
    runKimiContextHook();
    break;
  case '--kimi-hook':
    runKimiHook();
    break;
  case '--kimi-session-end':
    finishSource('kimi');
    break;
  case '--cursor-context-hook':
    runCursorContextHook();
    break;
  case '--cursor-session-end':
    finishSource('cursor');
    break;
  default:
    main();
}
