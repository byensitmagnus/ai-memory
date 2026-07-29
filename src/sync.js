#!/usr/bin/env node
'use strict';
/**
 * ai-memory sync — ÉN fælles pakke for Claude Code + Codex + Grok.
 *
 * Home-instruktioner er BYTE-IDENTISKE i:
 *   ~/.claude/CLAUDE.md
 *   ~/.codex/AGENTS.md
 *   ~/.grok/rules/00-ai-memory.md
 *
 * Indhold (i rækkefølge):
 *   INSTRUCTIONS  ← ~/.ai-memory/INSTRUCTIONS.md
 *   DURABLE       ← ~/.ai-memory/MEMORY.md
 *   SESSIONS      ← seneste session-resuméer (Claude + Codex + Grok)
 *   CLAUDE-MEMORY-MAP ← index over ~/.claude/projects/<projekt>/memory/
 *
 * Plus: Codex/Grok session-import til ~/.claude/session-data/, og bridge
 * (skills/agents/commands/projekt-AGENTS) via sync-claude-to-codex.js.
 *
 * Kør manuelt:  node ~/.ai-memory/sync.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const MEM_HOME = path.join(HOME, '.ai-memory');
const CANON = path.join(MEM_HOME, 'MEMORY.md');
const INSTRUCTIONS = path.join(MEM_HOME, 'INSTRUCTIONS.md');
const CONTEXT = path.join(MEM_HOME, 'CONTEXT.md');
const CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');
const CODEX_AGENTS = path.join(HOME, '.codex', 'AGENTS.md');
// Grok home-rules (altid loaded). Undgå dobbelt med ~/.claude/CLAUDE.md via
// [compat.claude] agents = false i ~/.grok/config.toml.
const GROK_RULES = path.join(HOME, '.grok', 'rules', '00-ai-memory.md');
const SESSION_STORE = path.join(HOME, '.claude', 'session-data');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const GROK_SESSIONS = path.join(HOME, '.grok', 'sessions');
const STATE_FILE = path.join(MEM_HOME, '.sync-state.json');
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');

/** Alle tre værktøjer får samme home-fil (100% ens). */
const HOME_TARGETS = [CLAUDE_MD, CODEX_AGENTS, GROK_RULES];

const MAP_PER_PROJECT_CAP = 3500;
const IMPORT_MAX_AGE_DAYS = 14;
const IMPORT_MAX_FILES = 25;
const EXPORT_RECENT = 12;

function log(msg) { process.stderr.write(`[ai-memory] ${msg}\n`); }
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function loadState() { try { return JSON.parse(readSafe(STATE_FILE)) || {}; } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

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

function writeIdentical(file, content) {
  const next = normalizeNewlines(content);
  const cur = normalizeNewlines(readSafe(file));
  if (cur === next) return false;
  ensureDir(path.dirname(file));
  try {
    fs.writeFileSync(file, next, 'utf8');
    log(`wrote identical package → ${file}`);
    return true;
  } catch (e) {
    log(`WARN could not write ${file}: ${e.message}`);
    return false;
  }
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

  const lines = ['## Seneste sessions (Claude Code + Codex + Grok)', ''];
  for (const { fp } of files) {
    const c = readSafe(fp);
    const proj = field(c, 'Project') || '?';
    const date = field(c, 'Date') || '';
    const src = field(c, 'Source') || 'Claude';
    const tasks = (c.match(/### Tasks\s*\n([\s\S]*?)(?:\n### |\n<!-- ECC:SUMMARY:END)/) || [, ''])[1]
      .split('\n').map(s => s.trim()).filter(s => s.startsWith('- ')).slice(0, 3)
      .map(s => cleanCodexUserText(s.replace(/^- /, ''))).filter(Boolean).join('; ');
    lines.push(`- **${proj}** (${date}, ${src}): ${tasks || '—'}`);
  }
  return lines.join('\n');
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

    let index = readSafe(path.join(memDir, 'MEMORY.md')).trim();
    if (index.length > MAP_PER_PROJECT_CAP) {
      index = index.slice(0, MAP_PER_PROJECT_CAP).trimEnd() +
        '\n…(afkortet — læs hele indexet i MEMORY.md i mappen ovenfor)';
    }
    const others = files.filter(n => n.toLowerCase() !== 'memory.md');
    sections.push([
      `### ${slug}`,
      `Mappe (læs detaljer direkte her): \`${memDir}\``,
      `Filer (${files.length}): ${others.slice(0, 80).map(n => '`' + n + '`').join(', ') || '—'}`,
      '',
      index ? `<details><summary>Index</summary>\n\n${index}\n\n</details>` : '_(ingen index)_',
    ].join('\n'));
  }
  if (!sections.length) return '_Ingen Claude projekt-memory fundet._';

  return [
    '## Claude projekt-memory (komplet index — 100% delt)',
    'Alt hvad Claude Code ved ligger i `~/.claude/projects/<projekt>/memory/`.',
    'Nedenfor er index + filstier for hvert projekt. Læs den relevante fil direkte når du har brug for detaljer (samme filsystem).',
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
    '# Fælles AI-pakke (Claude Code + Codex + Grok)',
    '',
    '> **100% ens home-instruktioner.** Auto-genereret af `~/.ai-memory/sync.js`.',
    '> Redigér kun `~/.ai-memory/INSTRUCTIONS.md` (adfærd), `~/.ai-memory/CONTEXT.md` (forretningskontekst) og `~/.ai-memory/MEMORY.md` (holdbare fakta).',
    '> Denne fil skrives identisk til `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` og `~/.grok/rules/00-ai-memory.md`.',
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
  let n = 0;
  for (const file of HOME_TARGETS) {
    if (writeIdentical(file, pkg)) n++;
  }
  if (!n) log('home-pakke allerede identisk på alle tre targets');
  else log(`home-pakke opdateret på ${n}/${HOME_TARGETS.length} targets`);
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

  const rollouts = listCodexRollouts()
    .filter(r => r.mtime > lastImport && r.mtime >= cutoff)
    .slice(0, IMPORT_MAX_FILES);

  let imported = 0, maxMtime = lastImport;
  for (const r of rollouts) {
    maxMtime = Math.max(maxMtime, r.mtime);
    const s = summarizeCodexRollout(r.path);
    if (!s) continue;
    const when = new Date(r.mtime);
    const short = (s.id || path.basename(r.path)).replace(/[^a-z0-9]/gi, '').slice(-8) || 'codex';
    const fname = `${dateStr(when)}-codex-${short}-session.tmp`;
    try {
      fs.writeFileSync(path.join(SESSION_STORE, fname), buildCodexSessionTmp(s, when));
      imported++;
    } catch (e) { log(`WARN write ${fname}: ${e.message}`); }
  }
  state.lastCodexImport = maxMtime;
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

  const summaries = listGrokSummaries()
    .filter(r => r.mtime > lastImport && r.mtime >= cutoff)
    .slice(0, IMPORT_MAX_FILES);

  let imported = 0, maxMtime = lastImport;
  for (const r of summaries) {
    maxMtime = Math.max(maxMtime, r.mtime);
    const s = summarizeGrokSession(r.path);
    if (!s) continue;
    const when = new Date(s.ts || r.mtime);
    const short = (s.id || 'grok').replace(/[^a-z0-9]/gi, '').slice(-8) || 'grok';
    const fname = `${dateStr(when)}-grok-${short}-session.tmp`;
    try {
      fs.writeFileSync(path.join(SESSION_STORE, fname), buildGrokSessionTmp(s, when));
      imported++;
    } catch (e) { log(`WARN write ${fname}: ${e.message}`); }
  }
  state.lastGrokImport = maxMtime;
  saveState(state);
  if (imported) log(`importerede ${imported} Grok-session(s) til delt store`);
  else log('ingen nye Grok-sessions at importere');
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
  // Skills, agents, commands, projekt-AGENTS — før home-pakke, så inventar er frisk.
  try { require('./sync-claude-to-codex').main(); } catch (e) { log(`bridge fejl: ${e.message}`); }
  try { importCodexSessions(); } catch (e) { log(`import codex fejl: ${e.message}`); }
  try { importGrokSessions(); } catch (e) { log(`import grok fejl: ${e.message}`); }
  // Én identisk pakke til Claude + Codex + Grok.
  try { writeHomePackage(); } catch (e) { log(`home-pakke fejl: ${e.message}`); }
}

main();
