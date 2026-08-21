'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

try {
  const home = os.userInfo().homedir;
  const input = fs.readFileSync(0);
  const script = path.join(home, '.ai-memory', 'sync.js');
  if (fs.existsSync(script)) {
    spawnSync(process.execPath, [script, '--kimi-hook'], {
      input,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 3500,
      windowsHide: true,
    });
  }
} catch {
  // Kimi hooks are continuity aids and must always fail open.
}
