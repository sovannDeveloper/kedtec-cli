import * as fs from 'fs';
import * as path from 'path';
import { ShellKind, shellKind } from './shell';

/**
 * Which shell commands may run *without asking*, and in Plan mode.
 *
 * This module exists because the file tools were replaced by `run_command`.
 * Those tools carried two guarantees that a shell command does not:
 *
 *   - `read_file` and the search tools needed no confirmation, so the agent
 *     could read the workspace freely. If every `cat` now costs a confirmation
 *     click the extension is unusable, so something has to decide which
 *     commands are reads.
 *   - `resolveSafe` refused a path outside the workspace, lexically *and*
 *     after `realpath`. Plan mode and subagents run with no confirmation gate
 *     at all, so without an equivalent here `cat ../../.ssh/id_rsa` is a
 *     one-line exfiltration in the mode that is supposed to be read-only.
 *
 * So this is a **default-deny classifier**: a command is read-only only if it
 * parses cleanly, uses nothing but an allowlisted executable per pipeline
 * segment, and names no path that leaves the workspace. Everything else is
 * "not provably read-only", which is not the same as "malicious" — it just
 * falls through to the confirmation gate, or is refused in Plan mode.
 *
 * The bias is deliberate: a false negative costs a confirmation prompt on a
 * harmless command, a false positive runs an unreviewed write. Every judgment
 * call here goes the first way.
 */

// ── tokenizer ────────────────────────────────────────────────────────────────
//
// Splitting on `|` with a regex is not good enough in either direction. It
// breaks `grep -E 'a|b'` (a quoted bar is not a pipeline), and it misses
// `cat x > y` (an operator that is not a bar at all). Both matter: the first is
// an ordinary search the agent will run constantly, the second is a write
// wearing a read's clothes. So the command is tokenized with quoting rules
// before anything is decided about it.

// `$` followed by something bash expands: a variable, a positional or special
// parameter, or `$'…'` / `$"…"` quoting (whose escapes turn `\x2e\x2e` into
// `..`). A `$` before anything else — `foo$`, `'a$b'` — is a literal.
const EXPANSION = /\$[A-Za-z_0-9@*#?!$'"-]/;

export type CommandItem =
  | { kind: 'word'; text: string; quoted: boolean }
  | { kind: 'op'; text: string };

/**
 * `cmd` as words and operators, or null when it cannot be parsed as a plain
 * command at all — an unterminated quote, a trailing backslash, or any form of
 * substitution or expansion (`$(…)`, `${…}`, backticks, `$HOME`, `$1`, `$'…'`,
 * `{a,b}`, `{1..3}`).
 *
 * Substitution is refused rather than analyzed: the whole point of it is that
 * the text that finally runs is not the text being looked at, so a classifier
 * that let it through would be deciding about a different command than the one
 * the shell executes. A plain `$HOME` is the same thing: `cat $HOME/.ssh/id_rsa`
 * reads as a path inside the project here and as the user's key to bash. So is
 * brace expansion: `cat {../x,}` is one odd name inside the project here and
 * `cat ../x` to bash, and `cat {~/.ssh/id_rsa,}` is the key again.
 */
export function tokenizeCommand(cmd: string): CommandItem[] | null {
  const items: CommandItem[] = [];
  let cur = '';
  let quoted = false;
  let started = false;
  // An unquoted `{` in the current word, and whether any word so far would be
  // brace-expanded. A word with a `{`, a `}` and a `,` or `..` between them is
  // treated as one, quoted parts included — `{'..',x}` expands too. `{}` (find
  // -exec) has neither, so it stays a literal.
  let brace = false;
  let expands = false;
  let i = 0;

  const endWord = () => {
    if (!started) return;
    if (brace && cur.includes('}') && /,|\.\./.test(cur)) expands = true;
    items.push({ kind: 'word', text: cur, quoted });
    cur = '';
    quoted = false;
    started = false;
    brace = false;
  };

  while (i < cmd.length) {
    const c = cmd[i];

    if (c === '\\') {
      // A trailing backslash means the command was cut off mid-escape.
      if (i + 1 >= cmd.length) return null;
      cur += cmd[i + 1];
      started = true;
      i += 2;
      continue;
    }

    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += cmd.slice(i + 1, end);
      quoted = true;
      started = true;
      i = end + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < cmd.length) { out += cmd[j + 1]; j += 2; continue; }
        out += cmd[j];
        j++;
      }
      if (j >= cmd.length) return null;
      // `$(`, `${` and backticks still substitute inside double quotes. The
      // check runs on the unescaped text, so an escaped-and-therefore-literal
      // `\$(` is refused too — a false negative, which is the safe direction.
      if (/\$[({]|`/.test(out) || EXPANSION.test(out)) return null;
      cur += out;
      quoted = true;
      started = true;
      i = j + 1;
      continue;
    }

    if (c === '`') return null;
    if (c === '$' && (cmd[i + 1] === '(' || cmd[i + 1] === '{')) return null;
    if (c === '$' && EXPANSION.test(cmd.slice(i, i + 2))) return null;

    if (/\s/.test(c)) {
      // A newline is a command separator, not whitespace — it ends the word and
      // is recorded as the operator it is.
      if (c === '\n' || c === '\r') { endWord(); items.push({ kind: 'op', text: '\n' }); i++; continue; }
      endWord();
      i++;
      continue;
    }

    if (c === '|') {
      endWord();
      if (cmd[i + 1] === '|') { items.push({ kind: 'op', text: '||' }); i += 2; }
      else { items.push({ kind: 'op', text: '|' }); i++; }
      continue;
    }

    if (c === '&' || c === ';' || c === '>' || c === '<' || c === '(' || c === ')') {
      endWord();
      const two = cmd.slice(i, i + 2);
      if (two === '&&' || two === '>>') { items.push({ kind: 'op', text: two }); i += 2; continue; }
      items.push({ kind: 'op', text: c });
      i++;
      continue;
    }

    if (c === '{') brace = true;
    cur += c;
    started = true;
    i++;
  }

  endWord();
  return expands ? null : items;
}

// ── the allowlist ────────────────────────────────────────────────────────────
//
// Executables that read and print and cannot be talked into writing a file.
// Default-deny, so the interesting part of this list is what is *missing*:
//
//   - `awk` writes with `print > "file"`, so it is out; `grep` and `sed -n`
//     cover the reading it would have done.
//   - `tee`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `chmod`, `ln`, `dd`,
//     `truncate`, `install` all write, obviously.
//   - `sh`, `bash`, `zsh`, `env`, `xargs`, `perl`, `python`, `node`, `ruby`
//     run arbitrary code, which makes the rest of this analysis meaningless.
//   - `curl`, `wget`, `nc`, `ssh` reach the network — read-only locally, but
//     "read-only" here has to mean the workspace *and* the machine's secrets
//     stay put, and `curl -d @file` posts a file to an attacker.
//   - `git` is out because `git_read` already covers the read half with its own
//     argument guards, and `git` proper has a very large write surface.
//   - `env` and `printenv` are reads that print the environment, which is where
//     API keys live. Refused for the same reason as `curl`.
const READ_ONLY_BINARIES = new Set([
  'cat', 'head', 'tail', 'nl', 'wc', 'ls', 'pwd', 'echo', 'printf',
  'basename', 'dirname', 'realpath', 'stat', 'file', 'du', 'df', 'tree',
  'sort', 'uniq', 'cut', 'tr', 'rev', 'comm', 'join', 'paste', 'fold', 'column',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  'find', 'sed', 'jq', 'diff', 'cmp', 'seq', 'date',
]);

// `find` actions that run something or write something. Everything else it does
// is a search.
const FIND_WRITE_ACTIONS = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0',
  '-fprintf', '-fls',
]);

// The only `sed` scripts treated as reads: line-range printing, which is what
// replaced `read_file_range`. Anything else — a substitution, an append, a `w`
// flag writing to a file — is refused, because telling a read-only `sed` script
// from a writing one in general means implementing sed's grammar.
const SED_READ_SCRIPT = /^\s*\$?\d*(?:\s*,\s*(?:\$|\d+))?\s*[pP]\s*$/;
// The only `sed` options allowed beside it. `-e` and `-f` are out: a second
// script is where `w ../../file` and GNU sed's `e command` hide, after a first
// one that passes the check above.
const SED_READ_FLAGS = /^-[nErsuz]+$/;

/** True when `arg` is an option rather than an operand. */
function isFlag(arg: string): boolean {
  return arg.startsWith('-') && arg !== '-' && arg !== '--';
}

/**
 * The part of a word that may name a path: an operand whole, or the value of a
 * `--name=value` option — `diff --from-file=/etc/passwd x` prints the file just
 * as well as an operand would. A short option's attached value (`-I/usr/x`)
 * cannot be told from bundled flags, so it is not checked; the readers whose
 * short options take a file are handled in `readerOptionRisk`.
 */
function pathPart(word: string): string | null {
  if (!isFlag(word)) return word;
  const eq = word.indexOf('=');
  return word.startsWith('--') && eq !== -1 ? word.slice(eq + 1) : null;
}

/**
 * Why an allowlisted reader is *not* a read with these options, or ''.
 *
 * The allowlist is about executables, but several of them write a file or run
 * a program when asked to through an option: `sort -o`, `uniq in out`,
 * `tree -o`, `rg --pre`, a pager, `file -C`. `jq` can print the environment,
 * and `--files0-from` reads its list of files from a file, which can name
 * anything. Each is refused here; a false negative only costs a prompt.
 */
function readerOptionRisk(exe: string, args: string[]): string {
  const long = (...names: string[]) => args.find(a => names.some(n => a === n || a.startsWith(`${n}=`)));
  const short = (letter: string) => args.find(a => /^-[A-Za-z]+$/.test(a) && a.includes(letter));
  const files0 = args.find(a => /^--?files0-from/.test(a));
  if (files0) return `${exe} ${files0} reads files named in another file`;
  switch (exe) {
    case 'sort': {
      const bad = long('--output', '--compress-program') ?? short('o');
      return bad ? `sort ${bad} writes a file or runs a program` : '';
    }
    case 'uniq':
      return args.filter(a => !isFlag(a)).length > 1 ? 'uniq with two operands writes the second' : '';
    case 'tree':
      return short('o') ? 'tree -o writes a file' : '';
    case 'rg': {
      const bad = long('--pre', '--pre-glob');
      return bad ? `rg ${bad} runs a program on every file` : '';
    }
    case 'ag': case 'ack': {
      const bad = long('--pager');
      return bad ? `${exe} ${bad} runs a program` : '';
    }
    case 'file':
      return long('--compile') ?? short('C') ? 'file -C writes a compiled magic file' : '';
    case 'jq':
      // `env` and `$ENV` are the environment, where API keys live; modules
      // (`-L`, import, include) load files from outside the project.
      if (args.some(a => /\benv\b|\$ENV\b/.test(a))) return 'jq env prints the environment';
      if (long('--library-path') || args.some(a => /^-L/.test(a) || /\b(?:import|include)\b/.test(a))) return 'jq loads modules from outside the project';
      return '';
    default:
      return '';
  }
}

// ── path containment ─────────────────────────────────────────────────────────

/**
 * `p` with symlinks resolved as far as it exists — the same trick `resolveSafe`
 * used, so a path being named before it exists still resolves through whatever
 * real directory does exist above it.
 */
export function realPathOfNearest(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (let hops = 0; ;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch { /* missing, or a link to nowhere */ }
    // A link whose target does not exist yet fails realpath just as a missing
    // file does, but writing through it creates the target. So it is followed
    // by hand, not walked past: `notes.md -> ~/.config/x` committed in a repo
    // would otherwise count as the project's own notes.md. The hop limit ends
    // a link loop.
    let target: string | undefined;
    try { if (hops < 40 && fs.lstatSync(cur).isSymbolicLink()) target = fs.readlinkSync(cur); } catch { /* not a link */ }
    if (target !== undefined) {
      cur = path.resolve(path.dirname(cur), target);
      hops++;
      continue;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.join(cur, ...rest);
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Whether `arg` can be shown to stay inside `root`.
 *
 * Two checks, for the two ways out. The lexical one catches `../` and an
 * absolute path written out; the `realpath` one catches a symlink committed
 * inside the repo that points at `~/.ssh` — which passes the first check
 * trivially and is exactly the case `resolveSafe`'s second check existed for.
 *
 * Args that are not paths at all (a grep pattern, a flag's value) resolve to
 * something inside the workspace that does not exist, which is fine: a
 * non-existent path cannot be read, and `realPathOfNearest` walks up to a real
 * ancestor that is still inside.
 */
function argStaysInside(arg: string, cwd: string, root: string): boolean {
  if (arg.startsWith('~')) return false;
  // Git Bash maps `/c/Users` to C:\Users and `/etc` into its own install
  // directory, while path.resolve would read either as a folder on the
  // project's drive. Neither can be shown to stay inside, so neither is.
  if (process.platform === 'win32' && /^[\\/]/.test(arg)) return false;
  const abs = path.resolve(cwd, arg);
  if (!isInside(abs, root)) return false;
  return isInside(realPathOfNearest(abs), realPathOfNearest(root));
}

// ── the classifier ───────────────────────────────────────────────────────────

// Everything below reads a command with bash's rules. cmd.exe has others —
// `%VAR%` expands anywhere, inside quotes too, and `^` escapes — so under it no
// verdict here would be about the command that actually runs, and nothing is
// approved without asking. Installing Git for Windows lifts this (see shell.ts).
const CMD_REASON = 'commands run in cmd.exe, which this check cannot analyse (install Git for Windows to use Git Bash)';

export interface CommandVerdict {
  /** True only when the command is provably a read that stays in the workspace. */
  readOnly: boolean;
  /** Why not, for the Plan-mode refusal message. Empty when readOnly. */
  reason: string;
}

/**
 * Classify one `run_command` invocation.
 *
 * `cwd` is where the command will actually run and `root` is the workspace, so
 * a command with a `cwd` of its own is judged against the paths it will really
 * resolve rather than against the workspace root.
 */
export function classifyCommand(command: string, cwd: string, root: string, shell: ShellKind = shellKind()): CommandVerdict {
  return classify(command, cwd, root, shell, true);
}

// Where credentials live. A read of one is never let through unasked, inside
// or out: what is read goes to the model. Best effort — a glob such as
// `~/.s*` is not expanded here.
const SECRET_PATH = /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.kedtec|\.config[\\/](gh|gcloud))([\\/]|$)/i;

export function isSecretPath(p: string): boolean {
  return SECRET_PATH.test(p);
}

/**
 * Whether `command` is provably a read, wherever the paths it names point —
 * `classifyCommand` without the "stays in the workspace" part. Auto mode runs
 * such a command unasked (`grep foo ~/.pub-cache/…`), except where it names a
 * credential location.
 */
export function readsAnywhere(command: string, cwd: string, root: string, shell: ShellKind = shellKind()): boolean {
  if (!classify(command, cwd, root, shell, false).readOnly) return false;
  const items = tokenizeCommand((command ?? '').trim()) ?? [];
  return !items.some(it => it.kind === 'word' && isSecretPath(pathPart(it.text) ?? ''));
}

function classify(command: string, cwd: string, root: string, shell: ShellKind, contained: boolean): CommandVerdict {
  const text = (command ?? '').trim();
  if (!text) return { readOnly: false, reason: 'empty command' };
  if (shell === 'cmd') return { readOnly: false, reason: CMD_REASON };

  const items = tokenizeCommand(text);
  if (!items) {
    return { readOnly: false, reason: 'it uses quoting, substitution or expansion this cannot verify' };
  }

  // A pipeline of reads is a read. Anything else — `;`, `&&`, `&`, a redirect,
  // a subshell, a newline — either writes or chains something unexamined.
  for (const it of items) {
    if (it.kind === 'op' && it.text !== '|') {
      const shown = it.text === '\n' ? 'a newline' : `"${it.text}"`;
      return { readOnly: false, reason: `it contains ${shown}, which can chain or redirect` };
    }
  }

  const segments: CommandItem[][] = [[]];
  for (const it of items) {
    if (it.kind === 'op') segments.push([]);
    else segments[segments.length - 1].push(it);
  }

  for (const seg of segments) {
    const words = seg.filter((w): w is { kind: 'word'; text: string; quoted: boolean } => w.kind === 'word');
    if (words.length === 0) return { readOnly: false, reason: 'it has an empty pipeline segment' };

    const exe = words[0].text;
    // An executable named by path sidesteps the allowlist's whole premise —
    // `/tmp/cat` is not `cat`.
    if (exe.includes('/')) {
      return { readOnly: false, reason: `it runs "${exe}" by path` };
    }
    if (!READ_ONLY_BINARIES.has(exe)) {
      return { readOnly: false, reason: `"${exe}" is not a known read-only command` };
    }

    const args = words.slice(1);

    if (exe === 'find') {
      const bad = args.find(a => FIND_WRITE_ACTIONS.has(a.text));
      if (bad) return { readOnly: false, reason: `find ${bad.text} runs or writes something` };
    }

    if (exe === 'sed') {
      // `-i` edits in place, `-e`/`-f` add scripts, and the rest of sed's
      // options are not needed to print lines. Only `sed -n '<range>p' file…`
      // survives: its first operand is the script, the others are files.
      const flags = args.filter(a => isFlag(a.text)).map(a => a.text);
      if (flags.some(f => f.startsWith('-i') || f === '--in-place')) {
        return { readOnly: false, reason: 'sed -i edits the file in place' };
      }
      if (!flags.every(f => SED_READ_FLAGS.test(f)) || !flags.some(f => f.includes('n'))) {
        return { readOnly: false, reason: 'sed is only treated as a read as `sed -n <range>p <files>`' };
      }
      const scripts = args.filter(a => !isFlag(a.text));
      if (scripts.length === 0 || !SED_READ_SCRIPT.test(scripts[0].text)) {
        return { readOnly: false, reason: 'sed is only treated as a read with a line-range print script' };
      }
    }

    const optionRisk = readerOptionRisk(exe, args.map(a => a.text));
    if (optionRisk) return { readOnly: false, reason: optionRisk };

    // Containment applies to operands and `--name=value` values. A grep
    // pattern that happens to start with `/` is a regex — but it is also
    // indistinguishable from a path here, so it is checked like one and a
    // rooted pattern costs a confirmation rather than being trusted.
    for (const a of contained ? args : []) {
      const p = pathPart(a.text);
      if (p === null) continue;
      if (!argStaysInside(p, cwd, root)) {
        return { readOnly: false, reason: `"${a.text}" is outside the workspace` };
      }
    }
  }

  return { readOnly: true, reason: '' };
}

// ── reach, for the confirmation card ─────────────────────────────────────────

export interface CommandReach {
  /** Operands that resolve outside the workspace, deduped, in the order written. */
  outside: string[];
  /**
   * True when the command could not be parsed at all — a substitution, an
   * unterminated quote — so `outside` being empty proves nothing.
   */
  unanalyzable: boolean;
}

// A card is read, not studied; past a handful of paths the list stops being
// something anyone checks and starts being something they scroll past.
const MAX_REPORTED_OUTSIDE = 5;

/**
 * Which paths a command names that leave the workspace.
 *
 * `classifyCommand` answers "is this provably a read", and bails at the first
 * operand that escapes because that is all a yes/no verdict needs. This answers
 * a different question, for a command that has already failed that test and is
 * on its way to the confirmation card: *what* does it reach?
 *
 * The card is the only control on a shell write — no `resolveSafe` applies to a
 * command's operands, by design, since a shell can do anything — so it has to
 * be worth reading. Before this, `npm test` and `rm -rf ~/Documents` produced
 * an identical card: same `danger` flag, same wording, nothing to tell them
 * apart at the moment of approving one.
 *
 * Deliberately not a gate. It informs the human; it never refuses.
 */
export function commandReach(command: string, cwd: string, root: string, shell: ShellKind = shellKind()): CommandReach {
  if (shell === 'cmd') return { outside: [], unanalyzable: true };
  const items = tokenizeCommand((command ?? '').trim());
  if (!items) return { outside: [], unanalyzable: true };

  const outside: string[] = [];
  for (const it of items) {
    if (it.kind !== 'word') continue;
    const p = pathPart(it.text);
    if (!p || argStaysInside(p, cwd, root)) continue;
    if (!outside.includes(it.text)) outside.push(it.text);
    if (outside.length >= MAX_REPORTED_OUTSIDE) break;
  }
  return { outside, unanalyzable: false };
}

// ── risk, for auto mode ──────────────────────────────────────────────────────

export interface CommandRisk {
  /** Why this command should still be confirmed in auto mode; '' when it may run. */
  reason: string;
}

// Executables auto mode never runs unasked: they act as another user, on the
// whole machine or across the network, or run text the agent assembled as code.
const ALWAYS_ASK = new Map<string, string>([
  ...['sudo', 'su', 'doas'].map(e => [e, 'runs as another user'] as [string, string]),
  ...['dd', 'mkfs', 'fdisk', 'diskutil', 'shred', 'truncate'].map(e => [e, 'can destroy data on disk'] as [string, string]),
  ...['shutdown', 'reboot', 'halt', 'kill', 'killall', 'pkill', 'launchctl', 'systemctl', 'crontab']
    .map(e => [e, 'acts on the machine, not the project'] as [string, string]),
  ...['ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp']
    .map(e => [e, 'reaches another machine'] as [string, string]),
  ...['eval', 'exec', 'source', '.'].map(e => [e, 'runs text as code'] as [string, string]),
  ['chown', 'changes file ownership'],
]);

// Interpreters a download must not be piped into.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'python', 'python3', 'node', 'perl', 'ruby', 'php']);

// Paths a redirect may name without leaving the project in any way that matters.
const HARMLESS_PATHS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

function has(words: string[], ...wanted: string[]): boolean {
  return words.some(w => wanted.includes(w));
}

// Short flags may be bundled (`-rf`): true when any bundle carries `letter`.
function hasShortFlag(words: string[], letter: string): boolean {
  return words.some(w => /^-[A-Za-z]+$/.test(w) && w.includes(letter));
}

function segmentRisk(words: string[], pipedFrom: string | undefined): string {
  // `FOO=1 cmd` and `env cmd` run cmd; `xargs cmd` runs it once per input line.
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  while (words[i] === 'env' || words[i] === 'xargs' || words[i] === 'nohup' || words[i] === 'time') {
    i++;
    while (i < words.length && (isFlag(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
  }
  const exe = path.basename(words[i] ?? '');
  const args = words.slice(i + 1);
  const sub = args.find(a => !isFlag(a)) ?? '';
  if (!exe) return '';

  const fixed = ALWAYS_ASK.get(exe) ?? (exe.startsWith('mkfs') ? 'can destroy data on disk' : undefined);
  if (fixed) return `${exe} ${fixed}`;
  if (SHELLS.has(exe) && pipedFrom && /^(curl|wget|fetch)$/.test(pipedFrom)) return `pipes a download into ${exe}`;
  if (SHELLS.has(exe) && pipedFrom) return `pipes text into ${exe} to run as code`;

  switch (exe) {
    case 'rm':
      if (hasShortFlag(args, 'r') || hasShortFlag(args, 'R') || has(args, '--recursive')) return 'rm -r deletes recursively';
      if (args.some(a => !isFlag(a) && /[*?]/.test(a))) return 'rm with a wildcard';
      return '';
    case 'find':
      return has(args, '-delete', '-exec', '-execdir', '-ok', '-okdir') ? `find ${args.find(a => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(a))} acts on every match` : '';
    case 'chmod':
      return hasShortFlag(args, 'R') || has(args, '--recursive') || args.some(a => /^0?777$/.test(a)) ? 'chmod recursively or to 777' : '';
    case 'git': {
      if (sub === 'push') return 'git push publishes to a remote';
      if (sub === 'reset' && has(args, '--hard')) return 'git reset --hard discards work';
      if (sub === 'clean') return 'git clean deletes untracked files';
      if ((sub === 'checkout' || sub === 'restore') && (has(args, '.', '--') || has(args, '--worktree'))) return `git ${sub} can discard changes`;
      if (sub === 'branch' && (has(args, '-D') || (has(args, '-d') && has(args, '--force')))) return 'git branch -D deletes a branch';
      if (sub === 'stash' && has(args, 'drop', 'clear')) return 'git stash drop/clear discards work';
      if (sub === 'rebase' || sub === 'filter-branch' || sub === 'filter-repo') return `git ${sub} rewrites history`;
      if (sub === 'commit' && has(args, '--amend')) return 'git commit --amend rewrites history';
      return '';
    }
    case 'npm': case 'pnpm': case 'yarn': case 'bun':
      if (has(args, 'publish', 'unpublish', 'deprecate', 'login', 'adduser', 'logout', 'owner', 'token')) return `${exe} ${sub} acts on the registry`;
      if (has(args, '-g', '--global') || (exe === 'yarn' && sub === 'global')) return `${exe} global install changes the machine`;
      return '';
    case 'pip': case 'pip3':
      return sub === 'uninstall' || (sub === 'install' && !has(args, '--user') && !process.env.VIRTUAL_ENV) ? `${exe} ${sub} outside a virtualenv changes the machine` : '';
    case 'brew': case 'apt': case 'apt-get': case 'yum': case 'dnf': case 'port':
      return `${exe} changes the machine's packages`;
    case 'curl':
      return has(args, '-d', '--data', '--data-binary', '--data-raw', '--data-urlencode', '-F', '--form', '-T', '--upload-file', '--json')
        || args.some((a, k) => (a === '-X' || a === '--request') && /^(POST|PUT|PATCH|DELETE)$/i.test(args[k + 1] ?? ''))
        ? 'curl sends data to a server' : '';
    case 'wget':
      return has(args, '--post-data', '--post-file', '--method') ? 'wget sends data to a server' : '';
    case 'docker': case 'podman':
      return has(args, 'rm', 'rmi', 'prune', 'push', 'kill') ? `${exe} ${args.find(a => ['rm', 'rmi', 'prune', 'push', 'kill'].includes(a))} removes or publishes` : '';
    case 'kubectl': case 'helm': case 'terraform': case 'pulumi':
      return has(args, 'delete', 'apply', 'destroy', 'uninstall', 'up', 'install', 'upgrade', 'replace', 'patch', 'scale', 'rollout')
        ? `${exe} ${sub} changes live infrastructure` : '';
    case 'gh':
      return has(args, 'create', 'merge', 'close', 'delete', 'edit', 'comment', 'review', 'release') ? `gh ${sub} acts on GitHub` : '';
    default:
      return '';
  }
}

/**
 * Whether auto mode should stop and ask before running a command.
 *
 * Auto mode runs what an engineer would run without thinking twice — builds,
 * tests, linters, installs into the project, file shuffling inside it — and
 * stops for what they would pause over: deleting recursively, discarding git
 * work, publishing, acting on the machine or another one, running a download.
 *
 * Fixed rules rather than a model's judgement, so the same command gets the
 * same answer every time and the list can be read. It errs towards asking: a
 * command it cannot parse, or one naming a path outside the project, is asked
 * about whatever it is.
 */
export function assessRisk(command: string, cwd: string, root: string, shell: ShellKind = shellKind()): CommandRisk {
  if (shell === 'cmd') return { reason: CMD_REASON };
  const items = tokenizeCommand((command ?? '').trim());
  if (!items) return { reason: 'it uses substitution, expansion or quoting that cannot be checked' };

  for (const it of items) {
    if (it.kind !== 'word') continue;
    const p = pathPart(it.text);
    if (!p || HARMLESS_PATHS.has(p)) continue;
    // A URL is an address, not a path in this project's filesystem.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) continue;
    if (!argStaysInside(p, cwd, root)) return { reason: `"${it.text}" is outside the project` };
  }

  let words: string[] = [];
  let pipedFrom: string | undefined;
  let previous: string | undefined;
  const flush = (): string => {
    const reason = words.length ? segmentRisk(words, pipedFrom) : '';
    previous = words.length ? path.basename(words.find(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? '') : previous;
    words = [];
    return reason;
  };
  for (const it of items) {
    if (it.kind === 'word') { words.push(it.text); continue; }
    const reason = flush();
    if (reason) return { reason };
    pipedFrom = it.text === '|' ? previous : undefined;
  }
  return { reason: flush() };
}

// ── display ──────────────────────────────────────────────────────────────────

/**
 * A short label for one shell command, for the chat's tool row and the
 * completion notification.
 *
 * This exists because the file tools took their label from a `path` argument
 * (`Write: src/app.ts`) and a shell command has no such field — the whole
 * operation is one opaque string, and a heredoc write is a string containing
 * the entire file. Rendered verbatim, the tool row for writing a 200-line file
 * is 200 lines tall, and the notification that used to say "wrote 1 file" says
 * nothing at all.
 *
 * Best-effort by nature: an unrecognized command falls back to its first line,
 * clipped. The verb prefix is load-bearing — `src/notify.ts` reads it back to
 * decide what the run actually did, since after the swap every one of those
 * calls arrives under the single name `run_command`.
 */
export function summarizeCommand(command: string): string {
  const text = (command ?? '').trim();
  if (!text) return 'Run';

  const firstLine = text.split('\n')[0].trim();
  const items = tokenizeCommand(firstLine);

  const clip = (s: string, n = 72) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const fallback = () => `Run: ${clip(firstLine)}${text.includes('\n') ? ' …' : ''}`;
  if (!items) return fallback();

  const words = items.filter((i): i is { kind: 'word'; text: string; quoted: boolean } => i.kind === 'word');
  if (words.length === 0) return fallback();

  // A redirect is the shell's way of writing a file, and the target is the one
  // thing worth showing — `cat > src/app.ts <<'EOF'` is a write to src/app.ts.
  const redirect = items.findIndex(i => i.kind === 'op' && (i.text === '>' || i.text === '>>'));
  if (redirect !== -1) {
    const target = items.slice(redirect + 1).find(i => i.kind === 'word');
    if (target && target.kind === 'word') return `Write: ${clip(target.text)}`;
  }

  const exe = words[0].text.split('/').pop() ?? words[0].text;
  const operands = words.slice(1).filter(w => !w.text.startsWith('-'));
  const first = operands[0]?.text ?? '';

  switch (exe) {
    case 'cat': case 'head': case 'tail': case 'nl':
      return first ? `Read: ${clip(first)}` : fallback();
    case 'sed':
      // `sed -n '10,20p' file` is the range read that replaced read_file_range;
      // the range is the informative half, so it is kept next to the path.
      return operands.length >= 2 ? `Read: ${clip(operands[1].text)} (${operands[0].text})` : fallback();
    case 'ls': case 'tree':
      return `List: ${clip(first || '.')}`;
    case 'find':
      return `Find: ${clip(operands.map(o => o.text).join(' ') || '.')}`;
    case 'grep': case 'egrep': case 'fgrep': case 'rg': case 'ag': case 'ack':
      return `Grep: ${clip(first)}`;
    case 'rm':
      return `Delete: ${clip(operands.map(o => o.text).join(' '))}`;
    case 'mv':
      return operands.length >= 2 ? `Move: ${clip(operands[0].text, 34)} → ${clip(operands[1].text, 34)}` : fallback();
    case 'cp':
      return operands.length >= 2 ? `Copy: ${clip(operands[0].text, 34)} → ${clip(operands[1].text, 34)}` : fallback();
    case 'mkdir':
      return `Mkdir: ${clip(first)}`;
    case 'touch':
      return `Write: ${clip(first)}`;
    default:
      return fallback();
  }
}
