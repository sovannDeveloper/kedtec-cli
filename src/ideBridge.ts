import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Installs the KEDTec CLI Bridge extension (ide-bridge/ in this repo, shipped
// as dist/kedtec-ide-bridge-<version>.vsix) into the VS Code window this
// terminal runs in, so the file and selection show up without anyone
// installing an extension by hand. It is the same move Claude Code makes.
//
// It runs only in a VS Code terminal (TERM_PROGRAM=vscode, which Cursor and
// other forks set too), only when no window is already reporting this project,
// and in the background: the editor's CLI takes a second or two to answer.

export const BRIDGE_ID = 'kedtec.kedtec-ide-bridge';

export function bundledBridge(dir = __dirname): { file: string; version: string } | null {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const found = names
    .map(n => /^kedtec-ide-bridge-(\d+\.\d+\.\d+)\.vsix$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => compareVersions(b[1], a[1]))[0];
  return found ? { file: path.join(dir, found[0]), version: found[1] } : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// The editor's own `code` command. It is often not on PATH (on a Mac it is
// opt-in), so it is found next to the editor's executable, which VS Code puts
// in every terminal it opens as VSCODE_GIT_ASKPASS_NODE:
//   Windows  …\Microsoft VS Code\Code.exe        → …\bin\code.cmd
//   Linux    /usr/share/code/code                → /usr/share/code/bin/code
//   macOS    …/Visual Studio Code.app/Contents/… → …/Contents/Resources/app/bin/code
// A remote window (SSH, WSL, containers) has no client binary there, but puts
// its own `code` on PATH, which is the fallback.
export function editorCli(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const exe = env.VSCODE_GIT_ASKPASS_NODE;
  const dirs: string[] = [];
  if (exe) {
    dirs.push(path.join(path.dirname(exe), 'bin'));
    const app = exe.indexOf('.app/');
    if (app !== -1) dirs.push(path.join(exe.slice(0, app + 4), 'Contents', 'Resources', 'app', 'bin'));
  }
  for (const dir of dirs) {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    // bin/ also holds code-tunnel and, on a server, code-server: not the editor CLI.
    const name = names.find(n => !/tunnel|server/.test(n) && (platform === 'win32' ? n.endsWith('.cmd') : !n.includes('.')));
    if (name) return path.join(dir, name);
  }
  return 'code';
}

function run(cli: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise(resolve => {
    // A .cmd file only runs through cmd.exe, and Node refuses to spawn one
    // without a shell; every part is quoted for the spaces in "Microsoft VS Code".
    const child = process.platform === 'win32'
      ? spawn([cli, ...args].map(a => `"${a}"`).join(' '), { shell: true, windowsHide: true })
      : spawn(cli, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', d => { stdout += d; });
    child.on('error', () => resolve({ ok: false, stdout }));
    child.on('close', code => resolve({ ok: code === 0, stdout }));
  });
}

// Installs or updates the bridge when it is missing or older than the bundled
// one. Resolves to what happened, for one line on screen; 'none' says nothing.
export async function ensureIdeBridge(): Promise<'installed' | 'updated' | 'failed' | 'none'> {
  if (process.env.TERM_PROGRAM !== 'vscode' || process.env.KEDTEC_NO_IDE_BRIDGE) return 'none';
  const bundled = bundledBridge();
  if (!bundled) return 'none';
  const cli = editorCli();
  const list = await run(cli, ['--list-extensions', '--show-versions']);
  if (!list.ok) return 'failed';
  const line = list.stdout.split(/\r?\n/).find(l => l.toLowerCase().startsWith(`${BRIDGE_ID}@`));
  const installed = line ? line.slice(BRIDGE_ID.length + 1).trim() : null;
  if (installed && compareVersions(installed, bundled.version) >= 0) return 'none';
  const done = await run(cli, ['--install-extension', bundled.file, '--force']);
  return !done.ok ? 'failed' : installed ? 'updated' : 'installed';
}
