#!/usr/bin/env node
'use strict';

/** ZCode Stop hook: save metadata only, then refresh the shared package. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const SESSION_STORE = path.join(HOME, '.claude', 'session-data');
const SYNC = path.join(HOME, '.ai-memory', 'sync.js');

function pad(value) { return String(value).padStart(2, '0'); }
function date(value) { return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`; }
function time(value) { return `${pad(value.getHours())}:${pad(value.getMinutes())}`; }
function log(message) { process.stderr.write(`[zcode-session-hook] ${message}\n`); }

function input() {
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function summary(event, now = new Date()) {
  const id = String(event.session_id || process.env.CLAUDE_SESSION_ID || 'unknown');
  const cwd = String(event.cwd || process.cwd());
  const project = path.basename(cwd.replace(/[\\/]+$/, '')) || 'unknown';
  return [
    `# Session (ZCode): ${date(now)}`,
    `**Date:** ${date(now)}`,
    `**Last Updated:** ${time(now)}`,
    `**Project:** ${project}`,
    `**Worktree:** ${cwd}`,
    '**Source:** ZCode',
    '',
    '---',
    '<!-- ECC:SUMMARY:START -->',
    '## Session Summary (metadata only)',
    `- ZCode session ${id}`,
    `- Transcript pointer: ${event.transcript_path || 'not provided'}`,
    '<!-- ECC:SUMMARY:END -->',
    '',
  ].join('\n');
}

function main() {
  if (process.argv.includes('--selftest')) {
    const output = summary({ session_id: 'selftest', cwd: path.join('tmp', 'demo'), last_assistant_message: 'PRIVATE' });
    const ok = output.includes('**Source:** ZCode') && output.includes('selftest') && !output.includes('PRIVATE');
    log(`selftest: ${ok ? 'OK' : 'FAIL'}`);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  try {
    const event = input();
    const now = new Date();
    const id = String(event.session_id || process.env.CLAUDE_SESSION_ID || 'unknown');
    const short = id.replace(/[^a-z0-9]/gi, '').slice(-12) || 'zcode';
    fs.mkdirSync(SESSION_STORE, { recursive: true });
    fs.writeFileSync(path.join(SESSION_STORE, `${date(now)}-zcode-${short}-session.tmp`), summary(event, now), 'utf8');
    if (fs.existsSync(SYNC)) {
      const result = spawnSync(process.execPath, [SYNC], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 45000 });
      if (result.error || result.status !== 0) log(`shared sync failed open (${result.status ?? result.error?.message})`);
    }
  } catch (error) {
    // Memory continuity must never block the user's ZCode session.
    log(`failed open: ${error.message}`);
  }
}

main();
