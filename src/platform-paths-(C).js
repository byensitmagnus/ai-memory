'use strict';

const path = require('path');

function appDataRoot(home, env = process.env, platform = process.platform) {
  if (env.APPDATA) return env.APPDATA;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return path.join(home, 'AppData', 'Roaming');
}

function kimiDesktopRunnerCandidates(appData, home, platform = process.platform) {
  const relative = path.join('daimon-bundle', 'app', 'daimon', 'dist', 'src', 'runner', 'cli.js');
  const candidates = [path.join(appData, 'kimi-desktop', relative)];
  if (platform === 'darwin') {
    const appRelative = path.join('Kimi.app', 'Contents', 'Resources', 'resources', relative);
    candidates.push(path.join('/Applications', appRelative));
    candidates.push(path.join(home, 'Applications', appRelative));
  }
  return candidates;
}

module.exports = { appDataRoot, kimiDesktopRunnerCandidates };
