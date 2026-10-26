// Builds the extension into ../dist/kedtec-ide-bridge-<version>.vsix, the copy
// the CLI installs (src/ideBridge.ts), after removing older ones so dist/ only
// ever ships the current version. tsc only type-checks; build.js bundles.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const { version } = require('./package.json');
fs.mkdirSync(dist, { recursive: true });
for (const name of fs.readdirSync(dist)) {
  if (/^kedtec-ide-bridge-.*\.vsix$/.test(name)) fs.unlinkSync(path.join(dist, name));
}
execSync('npx tsc -p .', { cwd: __dirname, stdio: 'inherit' });
require('./build.js');
execSync(`npx vsce package --skip-license --out "${path.join(dist, `kedtec-ide-bridge-${version}.vsix`)}"`, { cwd: __dirname, stdio: 'inherit' });
