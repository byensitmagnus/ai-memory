'use strict';
/**
 * Tests for the ai-memory engine.
 *
 *   node --test test/
 *
 * Node's built-in test runner, no dependencies — same promise as the tool itself.
 *
 * sync.js runs main() on require, so every test spawns it as a child process with
 * HOME and USERPROFILE pointed at a throwaway directory. That also makes the tests
 * a real check of the thing that actually runs on your machine, not of a mock.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-test-'));
let HOME;
let n = 0;

const p = (...seg) => path.join(HOME, ...seg);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const put = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };

function run(script, args = []) {
  return execFileSync(process.execPath, [script, ...args], {
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,
      APPDATA: p('AppData', 'Roaming'),
      XDG_CONFIG_HOME: p('.config'),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runWithInput(script, args, input, extraEnv = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,
      APPDATA: p('AppData', 'Roaming'),
      XDG_CONFIG_HOME: p('.config'),
      ...extraEnv,
    },
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const sync = () => run(p('.ai-memory', 'sync.js'));
const install = (args = []) => run(path.join(REPO, 'install.js'), args);
const doctor = () => run(p('.ai-memory', 'doctor.js'));

beforeEach(() => {
  HOME = path.join(ROOT, `home-${++n}`);
  fs.mkdirSync(HOME, { recursive: true });
});

after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const TARGETS = ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.grok/rules/00-ai-memory.md'];

// --- the core promise -------------------------------------------------------

test('renders the same bytes to all three harnesses', () => {
  install();
  const [a, b, c] = TARGETS.map((t) => read(p(...t.split('/'))));
  assert.ok(a.length > 0, 'nothing was generated');
  assert.strictEqual(a, b, 'Claude and Codex differ');
  assert.strictEqual(b, c, 'Codex and Grok differ');
});

test('renders the same bytes to every supported local harness', () => {
  fs.mkdirSync(p('.zcode'), { recursive: true });
  fs.mkdirSync(p('.kimi'), { recursive: true });
  const kimiRoot = p('AppData', 'Roaming', 'kimi-desktop', 'daimon-share', 'daimon');
  const kimiPrivateHome = path.join(kimiRoot, 'runtime', 'kimi-code', 'home');
  const kimiWorkspace = p('work', 'kimi-desktop-main');
  fs.mkdirSync(kimiPrivateHome, { recursive: true });
  fs.mkdirSync(kimiWorkspace, { recursive: true });
  put(path.join(kimiWorkspace, 'AGENTS.md'), '# Kimi project rules\n\nKEEP_KIMI_WORKSPACE\n');
  put(path.join(kimiRoot, 'config.json'), JSON.stringify({
    agents: { default: 'main', entries: { main: { workDir: kimiWorkspace } } },
  }));
  install();

  const targets = [
    '.claude/CLAUDE.md',
    '.codex/AGENTS.md',
    '.grok/rules/00-ai-memory.md',
    '.agents/AGENTS.md',
    '.cursorrules',
    '.zcode/AGENTS.md',
    'AppData/Roaming/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/.agents/AGENTS.md',
  ];
  const rendered = targets.map((target) => read(p(...target.split('/'))));
  assert.ok(rendered.every(Boolean), 'one or more harness packages are missing');
  assert.ok(rendered.every((body) => body === rendered[0]), 'harness packages differ');

  const mdc = read(p('.cursor', 'rules', '00-ai-memory.mdc'));
  assert.match(mdc, /^---\ndescription: .+\nalwaysApply: true\n---\n\n/);
  assert.strictEqual(mdc.slice(mdc.indexOf('\n---\n\n') + 6), rendered[0]);

  const workspace = read(path.join(kimiWorkspace, 'AGENTS.md'));
  assert.ok(workspace.includes('KEEP_KIMI_WORKSPACE'), 'Kimi project rules were overwritten');
  assert.ok(workspace.includes('AI-MEMORY:KIMI-WORKSPACE:START'), 'Kimi managed block is missing');
  assert.ok(workspace.includes(rendered[0].trim()), 'Kimi workspace did not receive the shared package');

  put(p('.ai-memory', 'MEMORY.md'), '# Updated\n\nKIMI_WORKSPACE_REFRESH\n');
  sync();
  const refreshed = read(path.join(kimiWorkspace, 'AGENTS.md'));
  assert.ok(refreshed.includes('KEEP_KIMI_WORKSPACE'), 'Kimi project rules were lost on refresh');
  assert.ok(refreshed.includes('KIMI_WORKSPACE_REFRESH'), 'Kimi managed block stayed stale');
  assert.strictEqual((refreshed.match(/AI-MEMORY:KIMI-WORKSPACE:START/g) || []).length, 1, 'Kimi block was duplicated');
});

test('every managed block is present and in order', () => {
  install();
  const md = read(p('.claude', 'CLAUDE.md'));
  const order = ['INSTRUCTIONS', 'CONTEXT', 'DURABLE', 'SESSIONS', 'CLAUDE-MEMORY-MAP']
    .map((tag) => md.indexOf(`AI-MEMORY:${tag}:START`));
  assert.ok(order.every((i) => i >= 0), 'a block is missing');
  assert.deepStrictEqual(order, [...order].sort((x, y) => x - y), 'blocks are out of order');
  for (const tag of ['INSTRUCTIONS', 'CONTEXT', 'DURABLE']) {
    assert.ok(md.includes(`AI-MEMORY:${tag}:END`), `${tag} is not closed`);
  }
});

test('source content reaches the generated file verbatim', () => {
  install();
  put(p('.ai-memory', 'MEMORY.md'), '# Mine\n\nNever deploy on a Friday.\n');
  sync();
  assert.ok(read(p('.claude', 'CLAUDE.md')).includes('Never deploy on a Friday.'));
});

test('a missing CONTEXT.md drops the block instead of writing a placeholder', () => {
  install();
  fs.rmSync(p('.ai-memory', 'CONTEXT.md'));
  sync();
  const md = read(p('.claude', 'CLAUDE.md'));
  assert.ok(!md.includes('AI-MEMORY:CONTEXT:START'), 'empty CONTEXT block was written anyway');
  assert.ok(md.includes('AI-MEMORY:DURABLE:START'), 'the rest of the package survived');
});

test('running twice changes nothing', () => {
  install();
  const before = TARGETS.map((t) => fs.statSync(p(...t.split('/'))).mtimeMs);
  sync();
  const after = TARGETS.map((t) => fs.statSync(p(...t.split('/'))).mtimeMs);
  assert.deepStrictEqual(after, before, 'a file was rewritten with identical content');
});

test('doctor reports warnings honestly without writing', () => {
  install();
  const before = fs.statSync(p('.claude', 'CLAUDE.md')).mtimeMs;
  const output = doctor();
  const after = fs.statSync(p('.claude', 'CLAUDE.md')).mtimeMs;
  assert.ok(output.includes('ALIGNED WITH WARNINGS'), 'doctor hid its warnings');
  assert.ok(!output.includes('100% ALIGNED'), 'doctor overstated warning-bearing evidence');
  assert.strictEqual(after, before, 'doctor must stay read-only');
});

test('doctor accepts bridged skill links as real skills', () => {
  install();
  put(p('.claude', 'skills', 'demo', 'SKILL.md'), '# demo\n');
  sync();
  const output = doctor();
  assert.ok(output.includes('PASS  Skill-bridge'), 'doctor rejected the bridged skill link');
});

// --- the memory map ---------------------------------------------------------

test('project memory map exposes bounded hints instead of injecting full indexes', () => {
  install();
  const dir = p('.claude', 'projects', 'big', 'memory');
  put(path.join(dir, 'MEMORY.md'), '# Index\n- ' + 'x'.repeat(9000));
  sync();
  const md = read(p('.claude', 'CLAUDE.md'));
  assert.ok(md.includes(dir), 'the direct memory pointer is missing');
  assert.ok(md.includes('…'), 'the bounded hint was not clipped');
  assert.ok(!md.includes('x'.repeat(200)), 'the full project index leaked into home instructions');
});

test('a namespace without a memory folder is skipped', () => {
  install();
  fs.mkdirSync(p('.claude', 'projects', 'no-memory-here'), { recursive: true });
  put(p('.claude', 'projects', 'real', 'memory', 'a.md'), 'kept');
  sync();
  const md = read(p('.claude', 'CLAUDE.md'));
  assert.ok(md.includes('**real**'), 'the real namespace is missing');
  assert.ok(!md.includes('no-memory-here'), 'an empty namespace was indexed');
});

// --- cross-harness session import -------------------------------------------

const rollout = (cwd, text) => [
  JSON.stringify({ type: 'session_meta', payload: { cwd, id: 'sess-1', timestamp: '2026-01-01T10:00:00Z' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }),
].join('\n') + '\n';

test('a Codex session becomes a line in the package', () => {
  install();
  put(p('.codex', 'sessions', '2026', 'rollout-a.jsonl'), rollout('/work/shop', 'fix the checkout total'));
  sync();
  const md = read(p('.claude', 'CLAUDE.md'));
  assert.ok(!md.includes('fix the checkout total'), 'raw prompt leaked into generated instructions');
  assert.ok(md.includes('Codex'), 'the source is not labelled');
  const imported = fs.readdirSync(p('.claude', 'session-data'))
    .map((name) => read(p('.claude', 'session-data', name)))
    .join('\n');
  assert.ok(imported.includes('fix the checkout total'), 'the private session file lost the prompt');
});

test('product wrappers are stripped from imported prompts', () => {
  install();
  const noisy = '<recommended_plugins>buy this</recommended_plugins> real task here';
  put(p('.codex', 'sessions', 'rollout-b.jsonl'), rollout('/work/shop', noisy));
  sync();
  const md = read(p('.claude', 'CLAUDE.md'));
  assert.ok(!md.includes('real task here'), 'raw prompt leaked into generated instructions');
  assert.ok(!md.includes('buy this'), 'wrapper noise leaked into the package');
  const imported = fs.readdirSync(p('.claude', 'session-data'))
    .map((name) => read(p('.claude', 'session-data', name)))
    .join('\n');
  assert.ok(imported.includes('real task here'), 'the private session file lost the prompt');
  assert.ok(!imported.includes('buy this'), 'wrapper noise survived sanitising');
});

test('imports are watermarked so the same session is not read twice', () => {
  install();
  put(p('.codex', 'sessions', 'rollout-c.jsonl'), rollout('/work/shop', 'only once'));
  sync();
  const state = () => JSON.parse(read(p('.ai-memory-runtime', 'sync-state.json')));
  const first = { files: fs.readdirSync(p('.claude', 'session-data')).length, mark: state().lastCodexImport };
  sync();
  assert.strictEqual(fs.readdirSync(p('.claude', 'session-data')).length, first.files, 'a duplicate was written');
  assert.strictEqual(state().lastCodexImport, first.mark, 'the watermark moved without new input');
  assert.ok(first.mark > 0, 'no watermark was recorded at all');
});

test('session import watermarks are machine-local, not part of shared memory', () => {
  install();
  put(p('.codex', 'sessions', 'rollout-state.jsonl'), rollout('/work/shop', 'keep state local'));
  sync();
  assert.ok(fs.existsSync(p('.ai-memory-runtime', 'sync-state.json')), 'no local runtime state was written');
  assert.ok(!fs.existsSync(p('.ai-memory', '.sync-state.json')), 'watermark leaked into shared ai-memory');
});

test('a legacy shared watermark is carried forward without deleting its recovery copy', () => {
  install();
  fs.rmSync(p('.ai-memory-runtime'), { recursive: true, force: true });
  put(p('.ai-memory', '.sync-state.json'), JSON.stringify({ lastCodexImport: 123 }));
  sync();
  const local = JSON.parse(read(p('.ai-memory-runtime', 'sync-state.json')));
  assert.ok(local.lastCodexImport >= 123, 'legacy watermark was not migrated');
  assert.ok(fs.existsSync(p('.ai-memory', '.sync-state.json')), 'legacy recovery copy was deleted');
});

test('a Grok session is joined with its prompt history', () => {
  install();
  const dir = p('.grok', 'sessions', 'ws');
  put(path.join(dir, 'abc', 'summary.json'), JSON.stringify({ info: { cwd: '/work/shop', id: 'abc' }, updated_at: '2026-01-02T09:00:00Z' }));
  put(path.join(dir, 'prompt_history.jsonl'), [
    JSON.stringify({ session_id: 'abc', prompt: 'grok did this bit' }),
    JSON.stringify({ session_id: 'abc', prompt: 'ls -la', is_bash: true }),
    JSON.stringify({ session_id: 'other', prompt: 'belongs elsewhere' }),
  ].join('\n'));
  sync();
  const md = read(p('.claude', 'CLAUDE.md'));
  assert.ok(!md.includes('grok did this bit'), 'raw Grok prompt leaked into generated instructions');
  assert.ok(!md.includes('belongs elsewhere'), 'another session bled in');
  assert.ok(!md.includes('ls -la'), 'a shell command was imported as a prompt');
  const imported = fs.readdirSync(p('.claude', 'session-data'))
    .map((name) => read(p('.claude', 'session-data', name)))
    .join('\n');
  assert.ok(imported.includes('grok did this bit'), 'the private session file lost the Grok prompt');
  assert.ok(!imported.includes('belongs elsewhere'), 'another Grok session bled into the private summary');
  assert.ok(!imported.includes('ls -la'), 'a shell command was imported as a Grok prompt');
});

test('a Kimi session imports metadata only and never copies prompt text', () => {
  fs.mkdirSync(p('.kimi'), { recursive: true });
  install();
  const workDir = p('work', 'shop');
  const hash = crypto.createHash('md5').update(workDir).digest('hex');
  put(p('.kimi', 'kimi.json'), JSON.stringify({ work_dirs: [{ path: workDir, kaos: 'local' }] }));
  put(p('.kimi', 'sessions', hash, 'kimi-session-1', 'wire.jsonl'), [
    JSON.stringify({ type: 'metadata', protocol_version: '1.10' }),
    JSON.stringify({ timestamp: Date.now() / 1000, message: { type: 'TurnBegin', payload: { user_input: 'kimi fixed the invoice' } } }),
    JSON.stringify({ timestamp: Date.now() / 1000, message: { type: 'TurnEnd', payload: {} } }),
  ].join('\n') + '\n');

  sync();
  const imported = fs.readdirSync(p('.claude', 'session-data'))
    .map((name) => read(p('.claude', 'session-data', name)))
    .join('\n');
  assert.ok(imported.includes('Source: Kimi'), 'Kimi source label is missing');
  assert.ok(imported.includes('Kimi session kimi-session-1'), 'Kimi session pointer is missing');
  assert.ok(!imported.includes('kimi fixed the invoice'), 'raw Kimi prompt leaked into the shared store');
  assert.ok(!read(p('.claude', 'CLAUDE.md')).includes('kimi fixed the invoice'), 'raw Kimi prompt leaked into instructions');
});

test('Kimi lifecycle hook writes only a pointer and hook evidence', () => {
  fs.mkdirSync(p('.kimi'), { recursive: true });
  install();
  const workDir = p('work', 'kimi-hook');
  const sessionId = 'kimi-hook-session';
  const hash = crypto.createHash('md5').update(workDir).digest('hex');
  put(p('.kimi', 'sessions', hash, sessionId, 'wire.jsonl'), [
    JSON.stringify({ timestamp: Date.now() / 1000, message: { type: 'TurnBegin', payload: { user_input: 'KIMI_PRIVATE_CANARY' } } }),
    JSON.stringify({ timestamp: Date.now() / 1000, message: { type: 'TurnEnd', payload: {} } }),
  ].join('\n') + '\n');

  runWithInput(p('.ai-memory', 'sync.js'), ['--kimi-hook'], JSON.stringify({
    hook_event_name: 'SessionEnd',
    session_id: sessionId,
    cwd: workDir,
  }));

  const imported = fs.readdirSync(p('.claude', 'session-data'))
    .map((name) => read(p('.claude', 'session-data', name)))
    .join('\n');
  assert.ok(imported.includes(sessionId), 'session ID was not recorded');
  assert.ok(imported.includes('Runtime:** CLI'), 'runtime was not recorded');
  assert.ok(!imported.includes('KIMI_PRIVATE_CANARY'), 'hook copied private prompt text');
  const evidence = JSON.parse(read(p('.ai-memory-runtime', 'kimi-hook.json')));
  assert.strictEqual(evidence.event, 'SessionEnd');
  assert.strictEqual(evidence.runtime, 'CLI');
});

test('installer ships the Kimi Desktop native plugin adapter', () => {
  install();
  const root = p('.ai-memory', 'kimi-desktop-plugin');
  const manifest = JSON.parse(read(path.join(root, 'kimi.plugin.json')));
  assert.strictEqual(manifest.name, 'ai-memory');
  assert.deepStrictEqual(manifest.hooks.map((hook) => hook.event), ['SessionStart', 'SessionEnd']);
  assert.strictEqual(manifest.hooks[1].timeout, 4);
  const adapter = read(path.join(root, 'hook.cjs'));
  assert.ok(adapter.includes('os.userInfo().homedir'), 'adapter does not recover the real OS home');
  assert.ok(adapter.includes('--kimi-hook'), 'adapter does not call the bounded Kimi hook');
  assert.ok(adapter.includes('USERPROFILE'), 'adapter does not restore USERPROFILE');
});

test('uninstall removes only its owned Kimi Desktop plugin', () => {
  const managedRoot = p('AppData', 'Roaming', 'kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home', 'plugins', 'managed');
  const plugin = path.join(managedRoot, 'ai-memory');
  put(path.join(plugin, 'kimi.plugin.json'), read(path.join(REPO, 'src', 'kimi-desktop-plugin', 'kimi.plugin.json')));
  put(path.join(plugin, 'hook.cjs'), read(path.join(REPO, 'src', 'kimi-desktop-plugin', 'hook.cjs')));
  put(path.join(managedRoot, 'someone-else', 'keep.txt'), 'keep\n');

  install(['--uninstall']);

  assert.ok(!fs.existsSync(plugin), 'owned Kimi Desktop hook survived uninstall');
  assert.strictEqual(read(path.join(managedRoot, 'someone-else', 'keep.txt')), 'keep\n', 'another plugin was removed');

  put(path.join(plugin, 'kimi.plugin.json'), '{"name":"not-ours"}\n');
  install(['--uninstall']);
  assert.ok(fs.existsSync(plugin), 'an unowned Kimi Desktop directory was removed');
});

// --- the installer ----------------------------------------------------------

test('installing keeps hooks that were already there', () => {
  const settings = p('.claude', 'settings.json');
  put(settings, JSON.stringify({
    theme: 'dark',
    hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }));
  install();
  const cfg = JSON.parse(read(settings));
  assert.strictEqual(cfg.theme, 'dark', 'unrelated settings were dropped');
  const commands = cfg.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands.includes('echo mine'), 'the existing hook was removed');
  assert.ok(commands.some((c) => c.includes('.ai-memory/sync.js')), 'our hook was not added');
});

test('installing twice does not register the hook twice', () => {
  install();
  install();
  const cfg = JSON.parse(read(p('.claude', 'settings.json')));
  const ours = cfg.hooks.SessionStart
    .flatMap((g) => g.hooks)
    .filter((h) => String(h.command).includes('.ai-memory/sync.js'));
  assert.strictEqual(ours.length, 1, `registered ${ours.length} times`);
});

test('an older split-path hook is recognised instead of duplicated', () => {
  const settings = p('.claude', 'settings.json');
  put(settings, JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: "node -e \"const p=['.ai-memory','sync.js']\"" }] }],
    },
  }));
  install();
  const cfg = JSON.parse(read(settings));
  const ours = cfg.hooks.SessionStart
    .flatMap((group) => group.hooks)
    .filter((hook) => String(hook.command).includes('.ai-memory') && String(hook.command).includes('sync.js'));
  assert.strictEqual(ours.length, 1, `registered ${ours.length} equivalent hooks`);
});

test('doctor accepts an equivalent split-path Claude hook', () => {
  put(p('.claude', 'settings.json'), JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: "node -e \"const p=['.ai-memory','sync.js']\"" }] }],
    },
  }));
  install();
  assert.ok(doctor().includes('PASS  Claude hooks'), 'doctor rejected the equivalent legacy hook');
});

test('Codex install owns the full shared-memory lifecycle without duplicates', () => {
  fs.mkdirSync(p('.codex'), { recursive: true });
  put(p('.codex', 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }] },
  }));
  install();
  const hooks = JSON.parse(read(p('.codex', 'hooks.json'))).hooks;
  for (const event of ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'Stop', 'SessionEnd']) {
    assert.ok(hooks[event], `${event} was not registered for Codex`);
    const ours = hooks[event].flatMap((group) => group.hooks || [])
      .filter((hook) => String(hook.command).includes('.ai-memory/sync.js'));
    assert.strictEqual(ours.length, 1, `${event} has ${ours.length} managed hooks`);
  }
  assert.ok(JSON.stringify(hooks).includes('echo keep-me'), 'an unrelated Codex hook was removed');

  const output = runWithInput(p('.ai-memory', 'sync.js'), ['--codex-context-hook'], JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'please fix this',
  }));
  const context = JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.ok(context.includes('ADHD'), 'Codex did not receive the always-on output form');
});

test('Codex prompt hook reads optional project context from the physical Obsidian source', () => {
  const source = p('Brain', '00-CLAUDE', 'ai-memory');
  fs.mkdirSync(source, { recursive: true });
  fs.symlinkSync(source, p('.ai-memory'), 'junction');
  put(p('Brain', '00-CLAUDE', 'scheduled', 'project-matcher.py'), [
    "'use strict';",
    "process.stdout.write('OBSIDIAN_PROJECT_CONTEXT');",
  ].join('\n'));
  fs.mkdirSync(p('.codex'), { recursive: true });
  install();

  const output = runWithInput(p('.ai-memory', 'sync.js'), ['--codex-context-hook'], JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Read the matching project from Obsidian',
  }), { AI_MEMORY_PYTHON: process.execPath });
  const context = JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.ok(context.includes('OBSIDIAN_PROJECT_CONTEXT'), 'the physical vault project matcher was not used');
});

test('Cursor session start refreshes the package and injects always-on ADHD context', () => {
  fs.mkdirSync(p('.cursor'), { recursive: true });
  install();
  put(p('.ai-memory', 'MEMORY.md'), '# Fresh from Obsidian\n\nCURSOR_FRESH_MEMORY\n');

  const output = runWithInput(p('.ai-memory', 'sync.js'), ['--cursor-context-hook'], JSON.stringify({
    hook_event_name: 'sessionStart',
    session_id: 'cursor-session-1',
  }));
  const response = JSON.parse(output);
  assert.ok(response.additional_context.includes('ADHD'), 'Cursor did not receive the always-on output form');
  assert.ok(read(p('.cursor', 'rules', '00-ai-memory.mdc')).includes('CURSOR_FRESH_MEMORY'), 'Cursor package stayed stale');
});

test('installer repairs native-memory forks and preserves unrelated config', () => {
  fs.mkdirSync(p('.grok'), { recursive: true });
  fs.mkdirSync(p('.zcode', 'v2'), { recursive: true });
  put(p('.grok', 'config.toml'), [
    '[other]',
    'enabled = true',
    '',
    '[memory]',
    'enabled = true',
    '',
    '[compat.claude]',
    'agents = true',
    'hooks = true',
    '',
    '[compat.cursor]',
    'hooks = true',
    '',
  ].join('\n'));
  put(p('.zcode', 'v2', 'setting.json'), JSON.stringify({ memoryEnabled: true, keep: 'yes' }));

  install();

  const grok = read(p('.grok', 'config.toml'));
  assert.match(grok, /\[other\]\nenabled = true/);
  assert.match(grok, /\[memory\]\nenabled = false/);
  assert.match(grok, /\[compat\.claude\]\nagents = false/);
  assert.match(grok, /\[compat\.claude\][\s\S]*?hooks = false/);
  assert.match(grok, /\[compat\.cursor\]\nhooks = false/);
  assert.deepStrictEqual(JSON.parse(read(p('.zcode', 'v2', 'setting.json'))), {
    memoryEnabled: false,
    keep: 'yes',
  });
});

test('Grok TOML repair preserves BOM, CRLF, comments and secret-looking values', () => {
  fs.mkdirSync(p('.grok'), { recursive: true });
  const sentinel = 'Bearer PRIVATE_SENTINEL_DO_NOT_LOG';
  const original = '\uFEFF' + [
    '[mcp.headers]',
    `authorization = "${sentinel}"`,
    '',
    '[memory] # keep this comment',
    'enabled = true # native fork',
    '',
    '[compat.claude]',
    'agents = true',
    'hooks = true',
    '',
    '[compat.cursor]',
    'hooks = true',
    '',
  ].join('\r\n');
  put(p('.grok', 'config.toml'), original);

  const output = install();
  const repaired = read(p('.grok', 'config.toml'));
  assert.ok(repaired.startsWith('\uFEFF'), 'UTF-8 BOM was lost');
  assert.ok(!/(?<!\r)\n/.test(repaired), 'CRLF was changed to LF');
  assert.ok(repaired.includes(sentinel), 'an unrelated header was altered');
  assert.ok(!output.includes(sentinel), 'a secret-looking value was logged');
  assert.match(repaired, /\[memory\] # keep this comment\r\nenabled = false # native fork/);
  const backups = fs.readdirSync(p('.grok')).filter((name) => name.startsWith('config.toml.bak-'));
  assert.strictEqual(backups.length, 1, 'Grok config did not get exactly one backup');
  assert.strictEqual(read(p('.grok', backups[0])), original, 'Grok backup is not the original config');
});

test('duplicate Grok memory tables fail closed', () => {
  fs.mkdirSync(p('.grok'), { recursive: true });
  const config = '[memory]\nenabled = true\n\n[memory]\nenabled = false\n';
  put(p('.grok', 'config.toml'), config);
  install();
  const repaired = read(p('.grok', 'config.toml'));
  assert.strictEqual(repaired, config, 'ambiguous TOML was not left untouched');
});

test('installer owns native Cursor and Kimi lifecycle hooks without shell dependencies', () => {
  fs.mkdirSync(p('.cursor'), { recursive: true });
  fs.mkdirSync(p('.kimi'), { recursive: true });
  put(p('.cursor', 'hooks.json'), JSON.stringify({
    version: 1,
    hooks: { sessionStart: [{ command: 'node keep-me.js' }] },
  }));
  put(p('.kimi', 'config.toml'), 'hooks = []\n\n[models]\nkeep = "yes"\n');

  install();

  const cursor = JSON.parse(read(p('.cursor', 'hooks.json')));
  assert.ok(JSON.stringify(cursor).includes('node keep-me.js'), 'an unrelated Cursor hook was removed');
  for (const event of ['sessionStart', 'afterAgentResponse']) {
    const ours = (cursor.hooks[event] || [])
      .filter((hook) => String(hook.command).includes('.ai-memory/sync.js'));
    assert.strictEqual(ours.length, 1, `${event} has ${ours.length} managed Cursor hooks`);
  }
  const managedCursor = (event) => cursor.hooks[event].find((hook) => String(hook.command).includes('.ai-memory/sync.js'));
  assert.ok(managedCursor('sessionStart').command.includes('--cursor-context-hook'));
  assert.ok(managedCursor('afterAgentResponse').command.includes('--cursor-session-end'));
  assert.ok(!JSON.stringify(cursor).includes('sh '), 'Cursor still depends on sh');

  const kimi = read(p('.kimi', 'config.toml'));
  assert.ok(kimi.includes('[models]\nkeep = "yes"'), 'unrelated Kimi config was removed');
  assert.doesNotMatch(kimi, /^hooks\s*=\s*\[\s*\]/m, 'default hooks=[] conflicts with [[hooks]]');
  for (const event of ['SessionStart', 'SessionEnd']) {
    assert.match(kimi, new RegExp(`\\[\\[hooks\\]\\][\\s\\S]*?event = "${event}"[\\s\\S]*?\\.ai-memory/sync\\.js`));
  }
  assert.ok(!kimi.includes('event = "Stop"'), 'Kimi Stop would run after every assistant turn');
  assert.ok(!kimi.includes('event = "UserPromptSubmit"'), 'Kimi prompt hook is redundant with AGENTS.md');
});

test('ZCode gets native hooks, shared extensions and metadata-only session recall', () => {
  fs.mkdirSync(p('.zcode', 'v2'), { recursive: true });
  put(p('.zcode', 'cli', 'config.json'), JSON.stringify({ keep: 'yes', hooks: { enabled: false } }));
  put(p('.zcode', 'v2', 'setting.json'), JSON.stringify({ memoryEnabled: true }));
  put(p('.claude', 'skills', 'demo', 'SKILL.md'), '# demo\n');
  put(p('.claude', 'agents', 'demo.md'), '---\nname: demo\ndescription: Demo\n---\n\nDo demo work.\n');
  put(p('.claude', 'commands', 'goal.md'), '---\ndescription: Shared goal\n---\n\nRead CLAUDE.md.\n');

  install();

  const config = JSON.parse(read(p('.zcode', 'cli', 'config.json')));
  assert.strictEqual(config.keep, 'yes', 'unrelated ZCode config was removed');
  assert.strictEqual(config.hooks.enabled, true, 'ZCode hooks were not enabled');
  assert.ok(JSON.stringify(config.hooks.events.SessionStart).includes('sync.js'), 'ZCode SessionStart is missing');
  assert.ok(JSON.stringify(config.hooks.events.Stop).includes('zcode-session-hook.js'), 'ZCode Stop is missing');
  assert.ok(fs.existsSync(p('.zcode', 'skills', 'demo', 'SKILL.md')), 'ZCode skill bridge is missing');
  assert.ok(fs.existsSync(p('.zcode', 'agents', 'demo.md')), 'ZCode agent bridge is missing');
  assert.ok(fs.existsSync(p('.zcode', 'commands', 'project-goal.md')), 'ZCode command bridge is missing');

  runWithInput(p('.ai-memory', 'zcode-session-hook.js'), [], JSON.stringify({
    session_id: 'zcode-session-1',
    cwd: p('work', 'zcode'),
    last_assistant_message: 'ZCODE_PRIVATE_CANARY',
  }));
  const imported = fs.readdirSync(p('.claude', 'session-data'))
    .map((name) => read(p('.claude', 'session-data', name)))
    .join('\n');
  assert.ok(imported.includes('Source:** ZCode'), 'ZCode source metadata is missing');
  assert.ok(imported.includes('zcode-session-1'), 'ZCode session ID is missing');
  assert.ok(!imported.includes('ZCODE_PRIVATE_CANARY'), 'ZCode copied assistant text');
});

test('doctor covers hooks, Kimi, Cursor and native-memory contracts', () => {
  fs.mkdirSync(p('.codex'), { recursive: true });
  fs.mkdirSync(p('.cursor'), { recursive: true });
  fs.mkdirSync(p('.kimi'), { recursive: true });
  fs.mkdirSync(p('.zcode', 'v2'), { recursive: true });
  const kimiRoot = p('AppData', 'Roaming', 'kimi-desktop', 'daimon-share', 'daimon');
  const kimiWorkspace = p('work', 'kimi-desktop-doctor');
  fs.mkdirSync(kimiWorkspace, { recursive: true });
  put(path.join(kimiRoot, 'config.json'), JSON.stringify({
    agents: { default: 'main', entries: { main: { workDir: kimiWorkspace } } },
  }));
  put(p('.codex', 'config.toml'), '[features]\nhooks = true\n');
  put(p('.grok', 'config.toml'), '[memory]\nenabled = true\n');
  put(p('.kimi', 'config.toml'), '[models]\nkeep = "yes"\n');
  put(p('.zcode', 'v2', 'setting.json'), JSON.stringify({ memoryEnabled: true }));
  install();

  const output = doctor();
  for (const label of ['Codex hooks', 'Cursor hooks', 'Kimi hooks', 'Kimi Desktop workspace', 'Grok Memory-kontrakt', 'Grok hook-isolation', 'ZCode Memory-kontrakt']) {
    assert.ok(output.includes(label), `doctor skipped ${label}`);
  }
  assert.ok(output.includes('ALIGNED WITH WARNINGS'), 'doctor hid optional runtime warnings');
  assert.ok(!output.includes('100% ALIGNED'), 'doctor overstated the expanded contract');
});

test('uninstalling removes our hooks and nothing else', () => {
  const settings = p('.claude', 'settings.json');
  const legacy = 'node -e "require(\'path\').join(\'.ai-memory\', \'sync.js\')"';
  put(settings, JSON.stringify({ hooks: { SessionStart: [{ matcher: '*', hooks: [
    { type: 'command', command: 'echo mine' },
    { type: 'command', command: legacy },
  ] }] } }));
  install();
  install(['--uninstall']);
  const raw = read(settings);
  const commands = Object.values(JSON.parse(raw).hooks || {})
    .flat()
    .flatMap((group) => (group.hooks || []).map((hook) => hook.command));
  assert.ok(!raw.includes('.ai-memory/sync.js'), 'our hook survived uninstall');
  assert.ok(!commands.includes(legacy), 'our legacy split-path hook survived uninstall');
  assert.deepStrictEqual(commands, ['echo mine'], 'someone else\'s hook was collateral damage');
});

test('uninstall never creates missing tool configs', () => {
  for (const dir of ['.claude', '.codex', '.cursor', '.kimi', '.zcode']) {
    fs.mkdirSync(p(dir), { recursive: true });
  }

  install(['--uninstall']);

  for (const file of [
    p('.claude', 'settings.json'),
    p('.codex', 'hooks.json'),
    p('.cursor', 'hooks.json'),
    p('.kimi', 'config.toml'),
    p('.zcode', 'cli', 'config.json'),
  ]) {
    assert.ok(!fs.existsSync(file), `uninstall created ${file}`);
  }
});

test('your three files are never overwritten once they exist', () => {
  install();
  const mine = '# do not touch\n';
  for (const f of ['INSTRUCTIONS.md', 'CONTEXT.md', 'MEMORY.md']) put(p('.ai-memory', f), mine);
  install();
  for (const f of ['INSTRUCTIONS.md', 'CONTEXT.md', 'MEMORY.md']) {
    assert.strictEqual(read(p('.ai-memory', f)), mine, `${f} was overwritten`);
  }
});

test('--check writes nothing at all', () => {
  const output = install(['--check']);
  assert.ok(!fs.existsSync(p('.ai-memory', 'sync.js')), '--check installed the engine anyway');
  assert.ok(!fs.existsSync(p('.claude', 'settings.json')), '--check wrote settings');
  assert.ok(output.includes('installer-owned'), '--check overstated its generated-package coverage');
});
