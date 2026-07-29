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
    env: { ...process.env, HOME, USERPROFILE: HOME },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const sync = () => run(p('.ai-memory', 'sync.js'));
const install = (args = []) => run(path.join(REPO, 'install.js'), args);

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

// --- the memory map ---------------------------------------------------------

test('a project index longer than the cap is truncated', () => {
  install();
  const dir = p('.claude', 'projects', 'big', 'memory');
  put(path.join(dir, 'MEMORY.md'), '# Index\n' + 'x'.repeat(9000));
  sync();
  const md = read(p('.claude', 'CLAUDE.md'));
  assert.ok(md.includes('…(afkortet'), 'the cap did not fire');
  assert.ok(!md.includes('x'.repeat(4000)), 'more than the cap made it through');
});

test('a namespace without a memory folder is skipped', () => {
  install();
  fs.mkdirSync(p('.claude', 'projects', 'no-memory-here'), { recursive: true });
  put(p('.claude', 'projects', 'real', 'memory', 'a.md'), 'kept');
  sync();
  const md = read(p('.claude', 'CLAUDE.md'));
  assert.ok(md.includes('### real'), 'the real namespace is missing');
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
  assert.ok(md.includes('fix the checkout total'), 'the prompt did not survive import');
  assert.ok(md.includes('Codex'), 'the source is not labelled');
});

test('product wrappers are stripped from imported prompts', () => {
  install();
  const noisy = '<recommended_plugins>buy this</recommended_plugins> real task here';
  put(p('.codex', 'sessions', 'rollout-b.jsonl'), rollout('/work/shop', noisy));
  sync();
  const md = read(p('.claude', 'CLAUDE.md'));
  assert.ok(md.includes('real task here'), 'the actual prompt was lost');
  assert.ok(!md.includes('buy this'), 'wrapper noise leaked into the package');
});

test('imports are watermarked so the same session is not read twice', () => {
  install();
  put(p('.codex', 'sessions', 'rollout-c.jsonl'), rollout('/work/shop', 'only once'));
  sync();
  const state = () => JSON.parse(read(p('.ai-memory', '.sync-state.json')));
  const first = { files: fs.readdirSync(p('.claude', 'session-data')).length, mark: state().lastCodexImport };
  sync();
  assert.strictEqual(fs.readdirSync(p('.claude', 'session-data')).length, first.files, 'a duplicate was written');
  assert.strictEqual(state().lastCodexImport, first.mark, 'the watermark moved without new input');
  assert.ok(first.mark > 0, 'no watermark was recorded at all');
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
  assert.ok(md.includes('grok did this bit'), 'the prompt was not joined in');
  assert.ok(!md.includes('belongs elsewhere'), 'another session bled in');
  assert.ok(!md.includes('ls -la'), 'a shell command was imported as a prompt');
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

test('uninstalling removes our hooks and nothing else', () => {
  const settings = p('.claude', 'settings.json');
  put(settings, JSON.stringify({ hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  install();
  install(['--uninstall']);
  const raw = read(settings);
  assert.ok(!raw.includes('.ai-memory/sync.js'), 'our hook survived uninstall');
  assert.ok(raw.includes('echo mine'), 'someone else\'s hook was collateral damage');
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
  install(['--check']);
  assert.ok(!fs.existsSync(p('.ai-memory', 'sync.js')), '--check installed the engine anyway');
  assert.ok(!fs.existsSync(p('.claude', 'settings.json')), '--check wrote settings');
});
