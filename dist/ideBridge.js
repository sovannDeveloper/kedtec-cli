"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BRIDGE_ID = void 0;
exports.bundledBridge = bundledBridge;
exports.compareVersions = compareVersions;
exports.editorCli = editorCli;
exports.ensureIdeBridge = ensureIdeBridge;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Installs the KEDTec CLI Bridge extension (ide-bridge/ in this repo, shipped
// as dist/kedtec-ide-bridge-<version>.vsix) into the VS Code window this
// terminal runs in, so the file and selection show up without anyone
// installing an extension by hand. It is the same move Claude Code makes.
//
// It runs only in a VS Code terminal (TERM_PROGRAM=vscode, which Cursor and
// other forks set too), only when no window is already reporting this project,
// and in the background: the editor's CLI takes a second or two to answer.
exports.BRIDGE_ID = 'kedtec.kedtec-ide-bridge';
function bundledBridge(dir = __dirname) {
    let names = [];
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return null;
    }
    const found = names
        .map(n => /^kedtec-ide-bridge-(\d+\.\d+\.\d+)\.vsix$/.exec(n))
        .filter((m) => m !== null)
        .sort((a, b) => compareVersions(b[1], a[1]))[0];
    return found ? { file: path.join(dir, found[0]), version: found[1] } : null;
}
function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++)
        if ((pa[i] || 0) !== (pb[i] || 0))
            return (pa[i] || 0) - (pb[i] || 0);
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
function editorCli(env = process.env, platform = process.platform) {
    const exe = env.VSCODE_GIT_ASKPASS_NODE;
    const dirs = [];
    if (exe) {
        dirs.push(path.join(path.dirname(exe), 'bin'));
        const app = exe.indexOf('.app/');
        if (app !== -1)
            dirs.push(path.join(exe.slice(0, app + 4), 'Contents', 'Resources', 'app', 'bin'));
    }
    for (const dir of dirs) {
        let names;
        try {
            names = fs.readdirSync(dir);
        }
        catch {
            continue;
        }
        // bin/ also holds code-tunnel and, on a server, code-server: not the editor CLI.
        const name = names.find(n => !/tunnel|server/.test(n) && (platform === 'win32' ? n.endsWith('.cmd') : !n.includes('.')));
        if (name)
            return path.join(dir, name);
    }
    return 'code';
}
function run(cli, args) {
    return new Promise(resolve => {
        // A .cmd file only runs through cmd.exe, and Node refuses to spawn one
        // without a shell; every part is quoted for the spaces in "Microsoft VS Code".
        const child = process.platform === 'win32'
            ? (0, child_process_1.spawn)([cli, ...args].map(a => `"${a}"`).join(' '), { shell: true, windowsHide: true })
            : (0, child_process_1.spawn)(cli, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout?.on('data', d => { stdout += d; });
        child.on('error', () => resolve({ ok: false, stdout }));
        child.on('close', code => resolve({ ok: code === 0, stdout }));
    });
}
// Installs or updates the bridge when it is missing or older than the bundled
// one. Resolves to what happened, for one line on screen; 'none' says nothing.
async function ensureIdeBridge() {
    if (process.env.TERM_PROGRAM !== 'vscode' || process.env.KEDTEC_NO_IDE_BRIDGE)
        return 'none';
    const bundled = bundledBridge();
    if (!bundled)
        return 'none';
    const cli = editorCli();
    const list = await run(cli, ['--list-extensions', '--show-versions']);
    if (!list.ok)
        return 'failed';
    const line = list.stdout.split(/\r?\n/).find(l => l.toLowerCase().startsWith(`${exports.BRIDGE_ID}@`));
    const installed = line ? line.slice(exports.BRIDGE_ID.length + 1).trim() : null;
    if (installed && compareVersions(installed, bundled.version) >= 0)
        return 'none';
    const done = await run(cli, ['--install-extension', bundled.file, '--force']);
    return !done.ok ? 'failed' : installed ? 'updated' : 'installed';
}
//# sourceMappingURL=ideBridge.js.map