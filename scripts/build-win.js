// Builds the NSIS installer and the Store appx in one electron-builder run.
//
// The Store package does not use CSC_LINK. scripts/sign-windows.js leaves
// *.appx unsigned so Partner Center can re-sign it. NSIS is signed only when
// CSC_LINK is already set, same as before. latest.yml stays the NSIS feed:
// appx.electronUpdaterAware is false.

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const publishFlagIndex = process.argv.indexOf('--publish');
const publishMode = publishFlagIndex === -1 ? 'never' : process.argv[publishFlagIndex + 1];

if (publishMode !== 'never' && publishMode !== 'always') {
  console.error('build-win: --publish must be never or always');
  process.exit(1);
}

const csc = process.env.CSC_LINK || process.env.WIN_CSC_LINK;
if (csc && String(csc).trim()) {
  console.log('CSC_LINK is set. NSIS will be signed. The Store appx is left unsigned.');
} else {
  console.log('CSC_LINK is not set. NSIS and the Store appx are both unsigned.');
}
console.log('Store appx does not use CSC_LINK. Partner Center re-signs that package.');

const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const result = spawnSync(process.execPath, [
  cli,
  '--win',
  '--publish', publishMode,
  '-c', 'electron-builder.config.js'
], {
  cwd: root,
  env: process.env,
  stdio: 'inherit'
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
