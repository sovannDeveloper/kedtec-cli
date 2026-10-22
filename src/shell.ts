import * as fs from 'fs';
import * as path from 'path';

// Which shell `run_command` and `!cmd` run in. On macOS and Linux that is bash
// (or sh). On Windows it is Git Bash when one can be found, and cmd.exe only
// when none can — for two reasons that both come down to bash being what
// everything else here assumes:
//
//   - the model writes bash. Told "cmd" it still reaches for `ls`, `&&` chains
//     with `export`, `$VAR` and single quotes, and cmd.exe reads every one of
//     those differently or not at all.
//   - shellSafety's tokenizer implements bash's quoting rules. cmd.exe has
//     different ones (`%VAR%` expands anywhere, `^` escapes, `\` is a path
//     separator), so a command judged "a read inside the project" under bash
//     rules can be something else once cmd.exe expands it. Under cmd.exe that
//     check therefore approves nothing — see `shellKind()` callers there.

export type ShellKind = 'bash' | 'cmd';

export interface Shell {
  kind: ShellKind;
  file: string;
  args(command: string): string[];
}

type Env = Record<string, string | undefined>;

/**
 * The bash.exe that ships with Git for Windows, or null.
 *
 * Never a bare `bash` from PATH: on Windows that is usually
 * `C:\Windows\System32\bash.exe`, the WSL launcher, which runs the command in
 * a Linux VM where the project's paths, node_modules and git do not line up.
 * So the candidates are an explicit override, then the Git install that the
 * `git` on PATH belongs to, then Git's standard install locations.
 */
export function findGitBash(env: Env, exists: (p: string) => boolean = fs.existsSync): string | null {
  const w = path.win32;
  const override = env.KEDTEC_GIT_BASH;
  if (override) return exists(override) ? override : null;

  const roots: string[] = [];
  // git.exe lives in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin.
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    if (!exists(w.join(dir, 'git.exe'))) continue;
    roots.push(w.resolve(dir, '..'), w.resolve(dir, '..', '..'));
  }
  for (const base of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
    if (base) roots.push(w.join(base, 'Git'));
  }
  if (env.LOCALAPPDATA) roots.push(w.join(env.LOCALAPPDATA, 'Programs', 'Git'));

  for (const root of roots) {
    const bash = w.join(root, 'bin', 'bash.exe');
    if (exists(bash)) return bash;
  }
  return null;
}

let cached: Shell | undefined;

export function currentShell(): Shell {
  if (cached) return cached;
  if (process.platform === 'win32') {
    const bash = findGitBash(process.env);
    cached = bash
      ? { kind: 'bash', file: bash, args: cmd => ['-c', cmd] }
      : { kind: 'cmd', file: process.env.ComSpec || 'cmd.exe', args: cmd => ['/d', '/s', '/c', cmd] };
  } else {
    const file = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    cached = { kind: 'bash', file, args: cmd => ['-c', cmd] };
  }
  return cached;
}

export function shellKind(): ShellKind {
  return currentShell().kind;
}

// How the shell is described to the model, in the system prompt and the tool.
export function shellDescription(): string {
  if (process.platform !== 'win32') return 'bash';
  return shellKind() === 'bash'
    ? 'Git Bash (bash on Windows; write POSIX commands and forward-slash paths, drives are /c/...)'
    : 'cmd.exe (Windows; no bash — use cmd syntax, e.g. dir, type, set, %VAR%)';
}
