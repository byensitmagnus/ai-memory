#!/usr/bin/env node
'use strict';

/**
 * Read-only health check for an ai-memory installation.
 *
 *   node ~/.ai-memory/doctor.js
 *   node ~/.ai-memory/doctor.js --json
 *
 * It intentionally never runs sync.js: a diagnostic command must not mutate a
 * machine while somebody is investigating drift or a sync conflict.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const MEM_HOME = path.join(HOME, '.ai-memory');
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const KIMI_DESKTOP_ROOT = path.join(APPDATA, 'kimi-desktop', 'daimon-share', 'daimon');
const KIMI_DESKTOP_HOME = path.join(KIMI_DESKTOP_ROOT, 'runtime', 'kimi-code', 'home');
const KIMI_WORKSPACE_START = '<!-- AI-MEMORY:KIMI-WORKSPACE:START -->';
const KIMI_WORKSPACE_END = '<!-- AI-MEMORY:KIMI-WORKSPACE:END -->';
const SOURCES = {
  instructions: path.join(MEM_HOME, 'INSTRUCTIONS.md'),
  context: path.join(MEM_HOME, 'CONTEXT.md'),
  memory: path.join(MEM_HOME, 'MEMORY.md'),
  bridge: path.join(MEM_HOME, 'sync-claude-to-codex.js'),
};
const TARGETS = [
  ['Claude Code', path.join(HOME, '.claude', 'CLAUDE.md')],
  ['Codex', path.join(HOME, '.codex', 'AGENTS.md')],
  ['Grok', path.join(HOME, '.grok', 'rules', '00-ai-memory.md')],
  ['Kimi', path.join(HOME, '.agents', 'AGENTS.md')],
  ['Cursor', path.join(HOME, '.cursorrules')],
];
const ZCODE_HOME = path.join(HOME, '.zcode');
if (fs.existsSync(ZCODE_HOME)) TARGETS.push(['ZCode', path.join(ZCODE_HOME, 'AGENTS.md')]);
if (fs.existsSync(KIMI_DESKTOP_HOME)) TARGETS.push(['Kimi Desktop', path.join(KIMI_DESKTOP_HOME, '.agents', 'AGENTS.md')]);
const kimiDesktopConfig = json(path.join(KIMI_DESKTOP_ROOT, 'config.json'));
const kimiDesktopAgent = kimiDesktopConfig?.agents?.default || 'main';
const kimiDesktopWorkDir = kimiDesktopConfig?.agents?.entries?.[kimiDesktopAgent]?.workDir;
const REQUIRED_BLOCKS = ['INSTRUCTIONS', 'DURABLE', 'SESSIONS', 'CLAUDE-MEMORY-MAP'];
const JSON_OUTPUT = process.argv.includes('--json');

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function listSkillNames(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      // Windows junctions report as symbolic links in Node's Dirent API even
      // though they are valid skill directories. The bridge deliberately uses
      // junctions so all harnesses see one physical skill source.
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function json(file) {
  try { return JSON.parse(read(file)); } catch { return null; }
}

function managedCommand(command) {
  const value = String(command || '').replace(/\\/g, '/');
  return value.includes('/.ai-memory/sync.js') || (value.includes('.ai-memory') && value.includes('sync.js'));
}

function claudeHookCount(config, event) {
  return (Array.isArray(config?.hooks?.[event]) ? config.hooks[event] : [])
    .flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
    .filter((hook) => managedCommand(hook?.command)).length;
}

function tomlBoolean(raw, section, key) {
  const lines = String(raw || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const escaped = String(section).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const starts = lines.map((line, index) => new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`).test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (starts.length !== 1) return null;
  let end = lines.length;
  for (let index = starts[0] + 1; index < lines.length; index++) {
    if (/^\s*\[/.test(lines[index])) { end = index; break; }
  }
  const keyEscaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const values = lines.slice(starts[0] + 1, end)
    .map((line) => line.match(new RegExp(`^\\s*${keyEscaped}\\s*=\\s*(true|false)\\s*(?:#.*)?$`)))
    .filter(Boolean);
  return values.length === 1 ? values[0][1] === 'true' : null;
}

function kimiHookEvents(raw) {
  const events = [];
  const lines = String(raw || '').split(/\r?\n/);
  for (let index = 0; index < lines.length;) {
    if (!/^\s*\[\[hooks\]\]/.test(lines[index])) { index++; continue; }
    const block = [lines[index++]];
    while (index < lines.length && !/^\s*\[/.test(lines[index])) block.push(lines[index++]);
    const body = block.join('\n');
    if (!body.includes('.ai-memory/sync.js')) continue;
    const event = body.match(/^\s*event\s*=\s*"([^"]+)"/m)?.[1];
    if (event) events.push(event);
  }
  return events;
}

function cursorState(key) {
  const database = path.join(APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(database)) return { verified: false, value: null };
  try {
    // Optional in Node 22+, unavailable on the Node 18 support floor.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(database, { readOnly: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    db.close();
    return { verified: true, value: row?.value ?? null };
  } catch { return { verified: false, value: null }; }
}

function brokenCursorAdhdHooks() {
  const root = path.join(HOME, '.cursor', 'plugins', 'cache', 'i-have-adhd', 'i-have-adhd');
  let versions;
  try { versions = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const broken = [];
  for (const version of versions) {
    if (!version.isDirectory()) continue;
    const file = path.join(root, version.name, 'hooks', 'hooks.json');
    if (/"command"\s*:\s*"sh\s/i.test(read(file))) broken.push(file);
  }
  return broken;
}

function obsidianVaults() {
  const registries = process.platform === 'win32'
    ? [path.join(APPDATA, 'obsidian', 'obsidian.json')]
    : process.platform === 'darwin'
      ? [path.join(HOME, 'Library', 'Application Support', 'obsidian', 'obsidian.json')]
      : [path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'obsidian', 'obsidian.json')];
  for (const file of registries) {
    const config = json(file);
    if (!config?.vaults) continue;
    return Object.values(config.vaults).map((vault) => vault?.path).filter(Boolean);
  }
  return [];
}

function realpath(file) {
  try { return fs.realpathSync(file); } catch { return ''; }
}

function kimiWorkspacePackage(content) {
  const start = content.indexOf(KIMI_WORKSPACE_START);
  const end = content.indexOf(KIMI_WORKSPACE_END, start + KIMI_WORKSPACE_START.length);
  if (start < 0 || end < 0 || content.indexOf(KIMI_WORKSPACE_START, start + 1) >= 0) return '';
  return content.slice(start + KIMI_WORKSPACE_START.length, end).trim();
}

function main() {
  const checks = [];
  const add = (name, ok, detail, level = 'fail') => checks.push({ name, ok, detail, level });

  add('Kilde: INSTRUCTIONS.md', Boolean(read(SOURCES.instructions)), SOURCES.instructions);
  add('Kilde: MEMORY.md', Boolean(read(SOURCES.memory)), SOURCES.memory);
  add('Bridge-script', Boolean(read(SOURCES.bridge)), SOURCES.bridge);

  const packages = TARGETS.map(([name, file]) => ({ name, file, content: read(file) }));
  for (const item of packages) {
    add(`Pakke: ${item.name}`, Boolean(item.content), item.file);
  }

  if (packages.every((item) => item.content)) {
    const hashes = packages.map((item) => sha256(item.content));
    add(
      `${packages.length} byte-identiske pakker`,
      hashes.every((hash) => hash === hashes[0]),
      hashes.every((hash) => hash === hashes[0]) ? `SHA-256 ${hashes[0]}` : 'Kør node ~/.ai-memory/sync.js for at genskabe dem.'
    );

    const canonical = packages[0].content;
    for (const block of REQUIRED_BLOCKS) {
      add(`Blok: ${block}`, canonical.includes(`AI-MEMORY:${block}:START`), 'Genereret pakke');
    }
    const hasContext = Boolean(read(SOURCES.context));
    add(
      'Blok: CONTEXT',
      hasContext === canonical.includes('AI-MEMORY:CONTEXT:START'),
      hasContext ? 'CONTEXT.md findes og er renderet.' : 'CONTEXT.md er valgfri og er ikke renderet.'
    );
  }

  const canonical = packages[0]?.content || '';
  const cursorMdc = read(path.join(HOME, '.cursor', 'rules', '00-ai-memory.mdc'));
  const cursorPrefix = '---\ndescription: Shared AI instructions and memory\nalwaysApply: true\n---\n\n';
  add(
    'Cursor alwaysApply-regel',
    Boolean(canonical) && cursorMdc === cursorPrefix + canonical,
    path.join(HOME, '.cursor', 'rules', '00-ai-memory.mdc')
  );

  if (kimiDesktopWorkDir && fs.existsSync(kimiDesktopWorkDir)) {
    const workspaceFile = path.join(kimiDesktopWorkDir, 'AGENTS.md');
    const workspacePackage = kimiWorkspacePackage(read(workspaceFile));
    add(
      'Kimi Desktop workspace',
      Boolean(canonical) && workspacePackage === canonical.trim(),
      workspacePackage ? `${workspaceFile} indeholder den aktuelle managed block og bevarer projektregler.` : `${workspaceFile} mangler en gyldig managed block.`
    );
  }

  const claudeSettings = json(path.join(HOME, '.claude', 'settings.json'));
  const claudeEvents = ['SessionStart', 'Stop', 'SessionEnd'];
  const claudeCounts = claudeEvents.map((event) => claudeHookCount(claudeSettings, event));
  add(
    'Claude hooks',
    claudeCounts.every((count) => count === 1),
    claudeEvents.map((event, index) => `${event}=${claudeCounts[index]}`).join(', ')
  );

  const codexHooks = json(path.join(HOME, '.codex', 'hooks.json'));
  const codexEvents = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'Stop', 'SessionEnd'];
  const codexCounts = codexEvents.map((event) => claudeHookCount(codexHooks, event));
  add(
    'Codex hooks',
    codexCounts.every((count) => count === 1),
    codexEvents.map((event, index) => `${event}=${codexCounts[index]}`).join(', ')
  );
  const codexConfigFile = path.join(HOME, '.codex', 'config.toml');
  if (fs.existsSync(codexConfigFile)) {
    add('Codex hook-feature', tomlBoolean(read(codexConfigFile), 'features', 'hooks') === true, '[features].hooks=true');
  } else {
    add('Codex hook-feature', false, 'Codex config findes ikke; runtime-flag er NOT VERIFIED.', 'warn');
  }

  const grokHookFile = path.join(HOME, '.grok', 'hooks', 'ai-memory.json');
  if (fs.existsSync(grokHookFile)) {
    const grokHooks = json(grokHookFile);
    const grokEvents = ['SessionStart', 'Stop', 'SessionEnd'];
    const counts = grokEvents.map((event) => (Array.isArray(grokHooks?.hooks?.[event]) ? grokHooks.hooks[event] : [])
      .flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
      .filter((hook) => managedCommand(hook?.command)).length);
    add('Grok hooks', counts.every((count) => count === 1), grokEvents.map((event, index) => `${event}=${counts[index]}`).join(', '));
  } else {
    add('Grok hooks', false, 'Grok er ikke installeret eller hook-filen mangler.', 'warn');
  }

  const cursorHooksFile = path.join(HOME, '.cursor', 'hooks.json');
  if (fs.existsSync(cursorHooksFile)) {
    const cursorHooks = json(cursorHooksFile);
    const events = ['sessionStart', 'afterAgentResponse'];
    const counts = events.map((event) => (Array.isArray(cursorHooks?.hooks?.[event]) ? cursorHooks.hooks[event] : [])
      .filter((hook) => managedCommand(hook?.command)).length);
    add('Cursor hooks', counts.every((count) => count === 1), events.map((event, index) => `${event}=${counts[index]}`).join(', '));
  } else {
    add('Cursor hooks', false, 'Cursor er ikke installeret eller hooks.json mangler.', 'warn');
  }

  const kimiConfigFile = path.join(HOME, '.kimi', 'config.toml');
  if (fs.existsSync(kimiConfigFile)) {
    const events = kimiHookEvents(read(kimiConfigFile)).sort();
    add('Kimi hooks', JSON.stringify(events) === JSON.stringify(['SessionEnd', 'SessionStart']), events.join(', ') || 'ingen');
  } else {
    add('Kimi hooks', false, 'Kimi CLI er ikke installeret eller config.toml mangler.', 'warn');
  }

  const zcodeConfigFile = path.join(ZCODE_HOME, 'cli', 'config.json');
  if (fs.existsSync(zcodeConfigFile)) {
    const zcode = json(zcodeConfigFile);
    const count = (event, script) => (Array.isArray(zcode?.hooks?.events?.[event]) ? zcode.hooks.events[event] : [])
      .flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
      .filter((hook) => Array.isArray(hook?.args) && hook.args.some((arg) => String(arg).replace(/\\/g, '/').includes(`/.ai-memory/${script}`))).length;
    const start = count('SessionStart', 'sync.js');
    const stop = count('Stop', 'zcode-session-hook.js');
    add('ZCode hooks', zcode?.hooks?.enabled === true && start === 1 && stop === 1, `enabled=${zcode?.hooks?.enabled === true}, SessionStart=${start}, Stop=${stop}`);
    const selftest = spawnSync(process.execPath, [path.join(MEM_HOME, 'zcode-session-hook.js'), '--selftest'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    add('ZCode session-hook', selftest.status === 0, selftest.status === 0 ? 'metadata-only selftest PASS' : 'selftest fejlede');
  } else if (fs.existsSync(ZCODE_HOME)) {
    add('ZCode hooks', false, 'ZCode config mangler.', 'fail');
  }

  const grokConfigFile = path.join(HOME, '.grok', 'config.toml');
  if (fs.existsSync(grokConfigFile)) {
    const grokConfig = read(grokConfigFile);
    add('Grok Memory-kontrakt', tomlBoolean(grokConfig, 'memory', 'enabled') === false, '[memory].enabled=false');
    add('Grok Claude-kompatibilitet', tomlBoolean(grokConfig, 'compat.claude', 'agents') === false, '[compat.claude].agents=false');
    const claudeHooks = tomlBoolean(grokConfig, 'compat.claude', 'hooks');
    const cursorHooks = tomlBoolean(grokConfig, 'compat.cursor', 'hooks');
    add(
      'Grok hook-isolation',
      claudeHooks === false && cursorHooks === false,
      `[compat.claude].hooks=${claudeHooks}, [compat.cursor].hooks=${cursorHooks}`
    );
  } else {
    add('Grok Memory-kontrakt', false, 'Grok config findes ikke; native memory er NOT VERIFIED.', 'warn');
  }

  const zcodeSettingsFile = path.join(ZCODE_HOME, 'v2', 'setting.json');
  if (fs.existsSync(zcodeSettingsFile)) {
    add('ZCode Memory-kontrakt', json(zcodeSettingsFile)?.memoryEnabled === false, 'memoryEnabled=false');
  } else {
    add('ZCode Memory-kontrakt', false, 'ZCode settings findes ikke; native memory er NOT VERIFIED.', 'warn');
  }

  const cursorMemory = cursorState('cursor/memoriesEnabled');
  if (cursorMemory.verified) {
    add('Cursor Memory-kontrakt', String(cursorMemory.value).toLowerCase() !== 'true', `cursor/memoriesEnabled=${cursorMemory.value}`);
  } else {
    add('Cursor Memory-kontrakt', false, 'Cursor state database kunne ikke læses; NOT VERIFIED.', 'warn');
  }
  const cursorClaude = cursorState('cursor/claudeMdEnabled');
  if (cursorClaude.verified && String(cursorClaude.value).toLowerCase() === 'true') {
    add('Cursor CLAUDE.md-dublet', false, 'cursor/claudeMdEnabled=true kan duplikere den globale MDC-regel.', 'warn');
  }
  const brokenAdhd = brokenCursorAdhdHooks();
  if (brokenAdhd.length) {
    add('Cursor ADHD-plugin', false, `${brokenAdhd.length} cache-hook(s) bruger den manglende sh-shell; MDC-reglen er stadig aktiv.`, 'warn');
  }

  if (fs.existsSync(KIMI_DESKTOP_HOME)) {
    const sourceRoot = path.join(MEM_HOME, 'kimi-desktop-plugin');
    const installedRoot = path.join(KIMI_DESKTOP_HOME, 'plugins', 'managed', 'ai-memory');
    const files = ['kimi.plugin.json', 'hook.cjs'];
    const same = files.every((file) => {
      const source = read(path.join(sourceRoot, file));
      const installed = read(path.join(installedRoot, file));
      return source && installed && sha256(source) === sha256(installed);
    });
    add('Kimi Desktop plugin', same, same ? 'native SessionStart/SessionEnd-adapter matcher engine-kilden.' : installedRoot);
  } else {
    add('Kimi Desktop plugin', false, 'Kimi Desktop er ikke installeret.', 'warn');
  }
  const kimiEvidence = json(path.join(HOME, '.ai-memory-runtime', 'kimi-hook.json'));
  add('Kimi runtime-bevis', Boolean(kimiEvidence?.event && kimiEvidence?.runtime), kimiEvidence ? `${kimiEvidence.runtime} ${kimiEvidence.event} ${kimiEvidence.at || ''}` : 'Ingen frisk lifecycle-evidens endnu.', 'warn');

  const vaults = obsidianVaults();
  if (vaults.length) {
    const memoryRoot = realpath(MEM_HOME);
    const owningVault = vaults.find((vault) => {
      const root = realpath(vault);
      return root && (memoryRoot === root || memoryRoot.startsWith(root + path.sep));
    });
    add('Obsidian source-of-truth', Boolean(owningVault), owningVault ? `${MEM_HOME} ligger fysisk i registreret vault ${owningVault}` : `${MEM_HOME} ligger ikke i en registreret vault.`);
  } else {
    add('Obsidian source-of-truth', false, 'Ingen registreret Obsidian-vault fundet; NOT VERIFIED.', 'warn');
  }

  const claudeSkills = listSkillNames(path.join(HOME, '.claude', 'skills'));
  const sharedSkills = listSkillNames(path.join(HOME, '.agents', 'skills'));
  if (claudeSkills.length) {
    const missing = claudeSkills.filter((name) => !sharedSkills.includes(name));
    add(
      'Skill-bridge',
      missing.length === 0,
      missing.length ? `Mangler i ~/.agents/skills: ${missing.slice(0, 8).join(', ')}` : `${claudeSkills.length} Claude-skills findes også i ~/.agents/skills.`
    );
  } else {
    add('Skill-bridge', true, 'Ingen Claude-skills installeret endnu.', 'warn');
  }

  const failed = checks.filter((check) => !check.ok && check.level === 'fail');
  const warnings = checks.filter((check) => !check.ok && check.level === 'warn');
  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify({ ok: failed.length === 0, warningCount: warnings.length, checks }, null, 2) + '\n');
  } else {
    for (const check of checks) {
      const state = check.ok ? 'PASS' : check.level === 'warn' ? 'WARN' : 'FAIL';
      process.stdout.write(`${state}  ${check.name} — ${check.detail}\n`);
    }
    const status = failed.length
      ? `NOT ALIGNED (${failed.length} fejl)`
      : warnings.length
        ? `ALIGNED WITH WARNINGS (${warnings.length})`
        : '100% ALIGNED';
    process.stdout.write(`\n${status}\n`);
  }
  return failed.length === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
