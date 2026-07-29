#!/usr/bin/env node
'use strict';

/**
 * Synkroniserer genbrugelige udvidelser på tværs af Claude Code + Codex + Grok.
 *
 * Skills:
 *   Claude-skills + Firecrawl-plugin-skills → ~/.agents/skills (junctions)
 *   Agents-only skills → junctions tilbage til ~/.claude/skills (bi-dir)
 *   (Grok scanner både ~/.claude/skills og ~/.agents/skills nativt)
 *
 * Agents:
 *   Claude .md → Codex .toml + Grok ~/.grok/agents/*.md (identisk kilde)
 *
 * Commands:
 *   Claude slash-commands → Codex/Grok-skills under ~/.agents/skills
 *
 * Projekt-instruktioner:
 *   CLAUDE.md spejles 1:1 til AGENTS.md (samme body), så alle tre værktøjer
 *   ser samme projektregler (Grok loader begge filnavne).
 *
 * Flytter aldrig credentials. Overskriver ikke brugeroprettede skill-mapper.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CLAUDE_HOME = path.join(HOME, '.claude');
const CODEX_HOME = path.join(HOME, '.codex');
const GROK_HOME = path.join(HOME, '.grok');
const USER_SKILLS = path.join(HOME, '.agents', 'skills');
const CLAUDE_SKILLS = path.join(CLAUDE_HOME, 'skills');
const CODEX_AGENTS = path.join(CODEX_HOME, 'agents');
const GROK_AGENTS = path.join(GROK_HOME, 'agents');
const GENERATED_MARKER = '<!-- genereret af ~/.ai-memory/sync-claude-to-codex.js -->';
const PROJECT_START = '<!-- AI-BRIDGE:CLAUDE-PROJECT:START -->';
const PROJECT_END = '<!-- AI-BRIDGE:CLAUDE-PROJECT:END -->';
const GROK_AGENT_MARKER = '<!-- genereret af ~/.ai-memory/sync-claude-to-codex.js (grok-agent) -->';

function log(message) {
  process.stderr.write(`[ai-bridge] ${message}\n`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function hasSkill(dir) {
  return fs.existsSync(path.join(dir, 'SKILL.md'));
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function ensureSkillLink(source, destRoot, counters) {
  if (!hasSkill(source)) return;
  const name = path.basename(source);
  const destination = path.join(destRoot, name);

  if (samePath(source, destination)) {
    counters.linksCurrent++;
    return;
  }

  if (fs.existsSync(destination)) {
    try {
      const target = fs.readlinkSync(destination);
      const resolved = path.resolve(path.dirname(destination), target);
      if (samePath(resolved, source)) {
        counters.linksCurrent++;
        return;
      }
    } catch {
      // Rigtig mappe eller ulæseligt link: bevar den (ingen overwrite).
    }
    counters.linksSkipped++;
    return;
  }

  ensureDir(destRoot);
  fs.symlinkSync(source, destination, 'junction');
  counters.linksCreated++;
}

function latestFirecrawlRoot() {
  const base = path.join(
    CLAUDE_HOME,
    'plugins',
    'cache',
    'claude-plugins-official',
    'firecrawl'
  );
  const versions = listDirs(base).sort((a, b) =>
    path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true })
  );
  return versions[0] || '';
}

function isGeneratedSkill(dir) {
  return readSafe(path.join(dir, 'SKILL.md')).includes(GENERATED_MARKER);
}

function syncSkillLinks(counters) {
  ensureDir(USER_SKILLS);
  ensureDir(CLAUDE_SKILLS);

  // Claude → shared agents skills
  for (const source of listDirs(CLAUDE_SKILLS)) {
    ensureSkillLink(source, USER_SKILLS, counters);
  }

  // Firecrawl plugin skills → shared
  const firecrawl = latestFirecrawlRoot();
  if (firecrawl) {
    for (const source of listDirs(path.join(firecrawl, 'skills'))) {
      ensureSkillLink(source, USER_SKILLS, counters);
    }
  }

  // Agents-only (fx firecrawl junctions, command-skills) → Claude, så inventar matcher
  for (const source of listDirs(USER_SKILLS)) {
    let real = source;
    try {
      real = fs.realpathSync(source);
    } catch {
      try {
        const target = fs.readlinkSync(source);
        real = path.isAbsolute(target) ? target : path.resolve(path.dirname(source), target);
      } catch { /* rigtig mappe */ }
    }
    // Allerede fysisk under Claude skills → skip
    const claudeRoot = CLAUDE_SKILLS.toLowerCase() + path.sep;
    if (real.toLowerCase().startsWith(claudeRoot) || samePath(path.dirname(real), CLAUDE_SKILLS)) {
      counters.linksCurrent++;
      continue;
    }
    ensureSkillLink(real, CLAUDE_SKILLS, counters);
  }
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return { fields: {}, body: raw.trim() };
  const lines = match[1].split(/\r?\n/);
  const fields = {};

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i].match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!current) continue;
    const key = current[1];
    let value = current[2].trim();
    if (value === '>' || value === '|') {
      const parts = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      value = parts.join(' ');
    }
    fields[key] = value.replace(/^['"]|['"]$/g, '');
  }

  return { fields, body: raw.slice(match[0].length).trim() };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function writeIfChanged(file, content) {
  const normalized = content.replace(/\r?\n/g, '\n').replace(/\s+$/, '') + '\n';
  if (readSafe(file).replace(/\r?\n/g, '\n') === normalized) return false;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, normalized, 'utf8');
  return true;
}

function syncAgents(counters) {
  ensureDir(CODEX_AGENTS);
  ensureDir(GROK_AGENTS);
  const sourceDir = path.join(CLAUDE_HOME, 'agents');
  let files = [];
  try {
    files = fs.readdirSync(sourceDir).filter(name => name.toLowerCase().endsWith('.md'));
  } catch {
    return;
  }

  for (const filename of files) {
    const raw = readSafe(path.join(sourceDir, filename));
    const parsed = parseFrontmatter(raw);
    const name = parsed.fields.name || path.basename(filename, '.md');
    const description = parsed.fields.description || `Importeret Claude-agent: ${name}`;
    const instructions = [
      'Denne agent er importeret fra Claude Code. Brug værktøjerne, der svarer til de værktøjer, instruktionerne nævner.',
      'Bevar opgavens scope, og følg gældende fælles instruktioner samt relevante skills.',
      '',
      parsed.body,
    ].join('\n');

    // Codex TOML
    const codexOut = [
      '# Genereret af ~/.ai-memory/sync-claude-to-codex.js',
      `name = ${tomlString(name)}`,
      `description = ${tomlString(description)}`,
      `developer_instructions = ${tomlString(instructions)}`,
    ].join('\n');
    if (writeIfChanged(path.join(CODEX_AGENTS, `${name}.toml`), codexOut)) {
      counters.agentsUpdated++;
    } else {
      counters.agentsCurrent++;
    }

    // Grok agent markdown (samme kilde-body; Grok forstår Claude-frontmatter)
    const existingGrok = readSafe(path.join(GROK_AGENTS, filename));
    if (existingGrok && !existingGrok.includes(GROK_AGENT_MARKER) && !existingGrok.includes(GENERATED_MARKER)) {
      counters.grokAgentsSkipped = (counters.grokAgentsSkipped || 0) + 1;
    } else {
      const grokOut = [
        '---',
        `name: ${name}`,
        `description: ${description}`,
        '---',
        '',
        GROK_AGENT_MARKER,
        '',
        parsed.body,
      ].join('\n');
      if (writeIfChanged(path.join(GROK_AGENTS, filename), grokOut)) {
        counters.grokAgentsUpdated = (counters.grokAgentsUpdated || 0) + 1;
      } else {
        counters.grokAgentsCurrent = (counters.grokAgentsCurrent || 0) + 1;
      }
    }
  }
}

const COMMAND_NAME_MAP = {
  goal: 'project-goal',
  ultraplan: 'ultraplan',
  ultrareview: 'ultrareview',
};

function adaptCommand(name, body) {
  let adapted = body
    .replace(/\bCLAUDE\.md\b/g, 'AGENTS.md')
    .replace(/~\/\.claude\/skills\//g, '~/.agents/skills/')
    .replace(/\bWorkflow tool\b/gi, 'Codex-subagentværktøjer')
    .replace(/\bWorkflow\b/g, 'Codex-subagentværktøjer')
    .replace(/`agentType:\s*'Plan'`/g, 'en planlægningsrolle')
    .replace(/EnterPlanMode/g, 'update_plan')
    .replace(/\.claude\/plans\//g, '.codex/plans/');

  if (name === 'ultrareview') {
    adapted = adapted
      .replace(/Invoke the \*\*`code-review`\*\* skill[^\n]*/i,
        'Kør en dyb Codex-kodereview med parallelle special-agenter for korrekthed, sikkerhed, tests og vedligeholdbarhed.')
      .replace(/This maps to `\/code-review ultra`[^\n]*/i,
        'Dette er brugerens eksplicitte tilladelse til at bruge subagents og GitHub-adgang, når den er tilgængelig.');
  }

  return [
    GENERATED_MARKER,
    'Codex-tilpasning: brug Codex-native værktøjer og subagents, hvis Claude-navne stadig optræder i den importerede arbejdsgang.',
    '',
    adapted,
  ].join('\n');
}

function syncCommands(counters) {
  const sourceDir = path.join(CLAUDE_HOME, 'commands');
  let files = [];
  try {
    files = fs.readdirSync(sourceDir).filter(name => name.toLowerCase().endsWith('.md'));
  } catch {
    return;
  }

  for (const filename of files) {
    const raw = readSafe(path.join(sourceDir, filename));
    const parsed = parseFrontmatter(raw);
    const sourceName = path.basename(filename, '.md');
    const name = COMMAND_NAME_MAP[sourceName] || `claude-${sourceName}`;
    const description = parsed.fields.description || `Importeret Claude-kommando: ${sourceName}`;
    const skill = [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      '',
      adaptCommand(sourceName, parsed.body),
    ].join('\n');
    const destination = path.join(USER_SKILLS, name, 'SKILL.md');
    const existing = readSafe(destination);
    if (existing && !existing.includes(GENERATED_MARKER)) {
      counters.commandsSkipped++;
      continue;
    }
    if (writeIfChanged(destination, skill)) counters.commandsUpdated++;
    else counters.commandsCurrent++;
  }
}

function normalizePath(value) {
  return path.resolve(String(value).replace(/\//g, path.sep));
}

function claudeProjectRoots() {
  let config;
  try { config = JSON.parse(readSafe(path.join(HOME, '.claude.json'))); } catch { return []; }
  const documents = path.join(HOME, 'Documents').toLowerCase();
  const roots = [];
  for (const value of Object.keys(config.projects || {})) {
    const root = normalizePath(value);
    if (!root.toLowerCase().startsWith(documents + path.sep)) continue;
    try { if (!fs.statSync(root).isDirectory()) continue; } catch { continue; }
    if (!roots.some(existing => samePath(existing, root))) roots.push(root);
  }
  return roots;
}

function findClaudeInstructions(root, depth = 0, found = []) {
  if (depth > 4) return found;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === 'claude.md') {
      found.push(path.join(root, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (/^(\.git|\.cache|node_modules|vendor|bin|obj|dist|build|backups?)$/i.test(entry.name)) continue;
    findClaudeInstructions(path.join(root, entry.name), depth + 1, found);
  }
  return found;
}

function lineSimilarity(a, b) {
  const lines = value => new Set(value
    .split(/\r?\n/)
    .map(line => line.trim().toLowerCase())
    .filter(line => line.length >= 12 && !line.startsWith('<!--')));
  const left = lines(a);
  const right = lines(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const line of left) if (right.has(line)) common++;
  return common / Math.min(left.size, right.size);
}

function projectBodyIdentical(source) {
  // 100% ens indhold: kun neutrale stier/navne, ingen tool-specifik omskrivning.
  return source
    .replace(/^#\s+CLAUDE\.md\s*[—-]?\s*/i, '# Projekt-instruktioner\n\n')
    .replace(/Auto-loaded ved hver Claude Code session/gi, 'Auto-loaded ved hver session (Claude/Codex/Grok)')
    .replace(/~\/\.claude\/CLAUDE\.md/g, '~/.ai-memory (fælles home-pakke)')
    .replace(/~\/\.codex\/AGENTS\.md/g, '~/.ai-memory (fælles home-pakke)')
    .trim();
}

function syncProjectInstructions(counters) {
  const files = [];
  for (const root of claudeProjectRoots()) findClaudeInstructions(root, 0, files);
  const unique = files.filter((file, index) =>
    files.findIndex(candidate => samePath(candidate, file)) === index
  );

  for (const sourceFile of unique) {
    const source = projectBodyIdentical(readSafe(sourceFile));
    if (!source) continue;
    const destination = path.join(path.dirname(sourceFile), 'AGENTS.md');
    // AGENTS.md = spejl af CLAUDE.md (managed block = hele body).
    const block = `${PROJECT_START}\n${source}\n${PROJECT_END}\n`;
    const existing = readSafe(destination);

    if (!existing.trim()) {
      writeIfChanged(destination, block);
      counters.projectsCreated++;
      continue;
    }

    const pattern = new RegExp(`${escapeRe(PROJECT_START)}[\\s\\S]*?${escapeRe(PROJECT_END)}`);
    if (pattern.test(existing)) {
      // Erstat kun managed blok — men hvis filen KUN er managed blok, skriv ren kopi.
      const onlyManaged = existing.replace(pattern, '').trim().length === 0;
      const next = onlyManaged ? block : existing.replace(pattern, `${PROJECT_START}\n${source}\n${PROJECT_END}`);
      if (writeIfChanged(destination, next)) counters.projectsUpdated++;
      else counters.projectsCurrent++;
      continue;
    }

    if (lineSimilarity(source, existing) >= 0.65) {
      writeIfChanged(destination, block);
      counters.projectsReplaced++;
    } else {
      // Bevar ekstra Codex-only indhold under managed spejl.
      writeIfChanged(destination, `${block}\n${existing.trim()}\n`);
      counters.projectsMerged++;
    }
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function main() {
  const counters = {
    linksCreated: 0,
    linksCurrent: 0,
    linksSkipped: 0,
    agentsUpdated: 0,
    agentsCurrent: 0,
    grokAgentsUpdated: 0,
    grokAgentsCurrent: 0,
    grokAgentsSkipped: 0,
    commandsUpdated: 0,
    commandsCurrent: 0,
    commandsSkipped: 0,
    projectsCreated: 0,
    projectsUpdated: 0,
    projectsReplaced: 0,
    projectsMerged: 0,
    projectsCurrent: 0,
  };

  try { syncSkillLinks(counters); } catch (error) { log(`skill-fejl: ${error.message}`); }
  try { syncAgents(counters); } catch (error) { log(`agent-fejl: ${error.message}`); }
  try { syncCommands(counters); } catch (error) { log(`kommando-fejl: ${error.message}`); }
  try { syncProjectInstructions(counters); } catch (error) { log(`projekt-fejl: ${error.message}`); }

  log(
    `skills: ${counters.linksCreated} nye, ${counters.linksCurrent} ajour, ${counters.linksSkipped} bevaret; ` +
    `agents codex: ${counters.agentsUpdated} opdateret, ${counters.agentsCurrent} ajour; ` +
    `agents grok: ${counters.grokAgentsUpdated} opdateret, ${counters.grokAgentsCurrent} ajour, ${counters.grokAgentsSkipped} bevaret; ` +
    `kommandoer: ${counters.commandsUpdated} opdateret, ${counters.commandsCurrent} ajour, ${counters.commandsSkipped} bevaret; ` +
    `projekter: ${counters.projectsCreated} oprettet, ${counters.projectsUpdated} opdateret, ` +
    `${counters.projectsReplaced} erstattet, ${counters.projectsMerged} flettet, ${counters.projectsCurrent} ajour`
  );
  return counters;
}

if (require.main === module) main();

module.exports = { main };
