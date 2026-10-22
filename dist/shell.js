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
exports.findGitBash = findGitBash;
exports.currentShell = currentShell;
exports.shellKind = shellKind;
exports.shellDescription = shellDescription;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * The bash.exe that ships with Git for Windows, or null.
 *
 * Never a bare `bash` from PATH: on Windows that is usually
 * `C:\Windows\System32\bash.exe`, the WSL launcher, which runs the command in
 * a Linux VM where the project's paths, node_modules and git do not line up.
 * So the candidates are an explicit override, then the Git install that the
 * `git` on PATH belongs to, then Git's standard install locations.
 */
function findGitBash(env, exists = fs.existsSync) {
    const w = path.win32;
    const override = env.KEDTEC_GIT_BASH;
    if (override)
        return exists(override) ? override : null;
    const roots = [];
    // git.exe lives in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin.
    for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
        if (!exists(w.join(dir, 'git.exe')))
            continue;
        roots.push(w.resolve(dir, '..'), w.resolve(dir, '..', '..'));
    }
    for (const base of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
        if (base)
            roots.push(w.join(base, 'Git'));
    }
    if (env.LOCALAPPDATA)
        roots.push(w.join(env.LOCALAPPDATA, 'Programs', 'Git'));
    for (const root of roots) {
        const bash = w.join(root, 'bin', 'bash.exe');
        if (exists(bash))
            return bash;
    }
    return null;
}
let cached;
function currentShell() {
    if (cached)
        return cached;
    if (process.platform === 'win32') {
        const bash = findGitBash(process.env);
        cached = bash
            ? { kind: 'bash', file: bash, args: cmd => ['-c', cmd] }
            : { kind: 'cmd', file: process.env.ComSpec || 'cmd.exe', args: cmd => ['/d', '/s', '/c', cmd] };
    }
    else {
        const file = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
        cached = { kind: 'bash', file, args: cmd => ['-c', cmd] };
    }
    return cached;
}
function shellKind() {
    return currentShell().kind;
}
// How the shell is described to the model, in the system prompt and the tool.
function shellDescription() {
    if (process.platform !== 'win32')
        return 'bash';
    return shellKind() === 'bash'
        ? 'Git Bash (bash on Windows; write POSIX commands and forward-slash paths, drives are /c/...)'
        : 'cmd.exe (Windows; no bash — use cmd syntax, e.g. dir, type, set, %VAR%)';
}
//# sourceMappingURL=shell.js.map