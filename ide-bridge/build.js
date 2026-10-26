// Bundles src/extension.ts, the chat panel and the CLI's core it imports from
// ../src (agent, tools, permissions…) with the `openai` SDK into one file,
// out/extension.js, so the .vsix needs no node_modules. esbuild and openai are
// the root package's: this folder is built from inside the repository.
//
// `node build.js --dev` (what F5 runs, see .vscode/launch.json) skips the
// minifying and writes a source map, so breakpoints in src/ and ide-bridge/src/
// work in the Extension Development Host. The .vsix never ships the map.
const esbuild = require('esbuild');
const path = require('path');

const dev = process.argv.includes('--dev');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
  outfile: path.join(__dirname, 'out', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  minify: !dev,
  sourcemap: dev,
  logLevel: 'warning',
});
