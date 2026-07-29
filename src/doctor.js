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

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const MEM_HOME = path.join(HOME, '.ai-memory');
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
];
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
      'Tre byte-identiske pakker',
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
  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify({ ok: failed.length === 0, checks }, null, 2) + '\n');
  } else {
    for (const check of checks) {
      const state = check.ok ? 'PASS' : check.level === 'warn' ? 'WARN' : 'FAIL';
      process.stdout.write(`${state}  ${check.name} — ${check.detail}\n`);
    }
    process.stdout.write(`\n${failed.length ? `NOT ALIGNED (${failed.length} fejl)` : '100% ALIGNED'}\n`);
  }
  return failed.length === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
