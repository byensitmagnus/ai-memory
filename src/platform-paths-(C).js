'use strict';

const path = require('path');

function appDataRoot(home, env = process.env, platform = process.platform) {
  if (env.APPDATA) return env.APPDATA;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return platformPath.join(home, 'Library', 'Application Support');
  return platformPath.join(home, 'AppData', 'Roaming');
}

function kimiDesktopRunnerCandidates(appData, home, platform = process.platform) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const relative = platformPath.join('daimon-bundle', 'app', 'daimon', 'dist', 'src', 'runner', 'cli.js');
  const candidates = [platformPath.join(appData, 'kimi-desktop', relative)];
  if (platform === 'darwin') {
    const appRelative = platformPath.join('Kimi.app', 'Contents', 'Resources', 'resources', relative);
    candidates.push(platformPath.join('/Applications', appRelative));
    candidates.push(platformPath.join(home, 'Applications', appRelative));
  }
  return candidates;
}

module.exports = { appDataRoot, kimiDesktopRunnerCandidates };
