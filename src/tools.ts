import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolSchema } from './client';
import { additionsOnly, unifiedDiff } from './diff';
import { IgnoreMatcher, loadIgnoreMatcher } from './ignore';
import { Permissions } from './permissions';
import { commandPrefix } from './permissions';
import { currentShell, shellDescription, shellKind } from './shell';
import { assessRisk, classifyCommand, commandReach, realPathOfNearest } from './shellSafety';
import { c, clip } from './ui';

// ── context ──────────────────────────────────────────────────────────────────

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed' }

// A question for the person, answered by picking an option or typing one.
export interface Question {
  question: string;
  // The short name on its tab when several are asked: "Focus".
  header?: string;
  options: { label: string; description?: string }[];
}

// How the person answered: an answer per question (undefined where they left
// one open), the questions dismissed, or "let's talk about it instead".
export type QuestionAnswers =
  | { kind: 'answered'; answers: (string | undefined)[] }
  | { kind: 'dismissed' }
  | { kind: 'chat' };

export interface ToolContext {
  root: string;
  permissions: Permissions;
  // Absolute path → mtime when this session last read or wrote it. A write to a
  // file that is not here (or changed on disk since) is refused: writing a file
  // from memory silently discards whatever the model did not remember.
  readState: Map<string, number>;
  todos: Todo[];
  signal: AbortSignal;
  // Shows what a running tool is doing, e.g. the command being run.
  status(label: string): void;
  // Puts questions to the person, all at once. Absent when nobody is there to
  // answer (print mode).
  ask?(questions: Question[]): Promise<QuestionAnswers>;
}

export interface ToolOutcome {
  // What the model reads.
  content: string;
  isError?: boolean;
  // What the person reads under the tool row (one short line, or a block).
  display?: string;
}

export interface Tool {
  name: string;
  // The label on the tool row: Read, Edit, Bash…
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
  summary(input: Record<string, unknown>, root: string): string;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

const fail = (content: string): ToolOutcome => ({ content, isError: true, display: content });

// ── paths ────────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function resolvePath(root: string, p: unknown): string {
  const raw = typeof p === 'string' && p.trim() ? p.trim() : '.';
  return path.resolve(root, expandHome(raw));
}

// Lexically and after following symlinks, so a link committed inside the repo
// that points at ~/.ssh — or at a file there that does not exist yet — does
// not count as inside.
export function isInsideRoot(abs: string, root: string): boolean {
  const inside = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  return inside(abs, root) && inside(realPathOfNearest(abs), realPathOfNearest(root));
}

export function displayPath(abs: string, root: string): string {
  const rel = path.relative(root, abs);
  return !rel ? '.' : rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel;
}

async function checkOutsideRead(abs: string, ctx: ToolContext, what: string): Promise<ToolOutcome | null> {
  if (isInsideRoot(abs, ctx.root)) return null;
  const verdict = await ctx.permissions.check({ kind: 'outside', title: `${what} ${abs} (outside the project)`, outsideRoot: true });
  return verdict.ok ? null : fail(verdict.message);
}

// ── walking ──────────────────────────────────────────────────────────────────

const MAX_WALK_FILES = 50_000;

interface WalkEntry { abs: string; rel: string }

// Every file under `dir`, skipping whatever the project's .gitignore ignores.
function walkFiles(dir: string, root: string, matcher: IgnoreMatcher, signal: AbortSignal): WalkEntry[] {
  const out: WalkEntry[] = [];
  const stack = [dir];
  while (stack.length > 0 && out.length < MAX_WALK_FILES) {
    if (signal.aborted) break;
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = path.join(current, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const insideRoot = !rel.startsWith('..');
      if (e.isDirectory()) {
        if (e.name === '.git' || (insideRoot && matcher.isIgnored(rel, true))) continue;
        stack.push(abs);
      } else if (e.isFile()) {
        if (insideRoot && matcher.isIgnored(rel, false)) continue;
        out.push({ abs, rel: insideRoot ? rel : abs });
      }
    }
  }
  return out;
}

// Every project file the search tools would see, relative and slash-separated
// (the @ completion in the input box). Asynchronous, unlike walkFiles: started
// in a home folder it lists 50,000 files over ~10s, and done synchronously that
// froze the input box mid-keystroke.
export async function listProjectFiles(root: string): Promise<string[]> {
  const matcher = loadIgnoreMatcher(root);
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < MAX_WALK_FILES) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const rel = path.relative(root, path.join(current, e.name)).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (e.name !== '.git' && !matcher.isIgnored(rel, true)) stack.push(path.join(current, e.name));
      } else if (e.isFile() && !matcher.isIgnored(rel, false)) out.push(rel);
    }
  }
  return out;
}

// gitignore-ish glob → RegExp. A pattern with no slash matches a file name at
// any depth ("*.test.ts"); one with a slash is matched against the path.
export function globToRegExp(glob: string): RegExp {
  let out = '';
  let inBrace = false;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i++; }
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') { out += '(?:'; inBrace = true; }
    else if (ch === '}' && inBrace) { out += ')'; inBrace = false; }
    else if (ch === ',' && inBrace) out += '|';
    else if ('\\^$.|+()[]'.includes(ch)) out += '\\' + ch;
    else out += ch;
  }
  return glob.includes('/') ? new RegExp(`^${out.replace(/^\\?\.\//, '')}$`) : new RegExp(`(?:^|/)${out}$`);
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ── output limits ────────────────────────────────────────────────────────────

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 30_000;

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = text.slice(0, 8000);
  const tail = text.slice(-(MAX_OUTPUT_CHARS - 8000));
  return `${head}\n\n… [${text.length - MAX_OUTPUT_CHARS} characters omitted] …\n\n${tail}`;
}

function countLines(s: string): number {
  return s === '' ? 0 : s.split('\n').length;
}

function diffStat(diff: string): string {
  let add = 0, del = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+')) add++;
    else if (l.startsWith('-')) del++;
  }
  return `${c.green(`+${add}`)} ${c.red(`-${del}`)}`;
}

// ── the tools ────────────────────────────────────────────────────────────────

const readFile: Tool = {
  name: 'read_file',
  label: 'Read',
  readOnly: true,
  description: 'Read a text file. Returns lines prefixed with their line number and "|" (e.g. "  42|code") — the prefix is not part of the file. '
    + `Reads up to ${MAX_READ_LINES} lines; use offset/limit for a range of a larger file. Reading a file is required before write_file or edit_file may change it.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project root or absolute.' },
      offset: { type: 'integer', description: '1-based line to start from.' },
      limit: { type: 'integer', description: 'How many lines to read.' },
    },
    required: ['path'],
  },
  summary: (i, root) => displayPath(resolvePath(root, i.path), root),
  async run(input, ctx) {
    const abs = resolvePath(ctx.root, input.path);
    const outside = await checkOutsideRead(abs, ctx, 'Read');
    if (outside) return outside;
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { return fail(`File not found: ${displayPath(abs, ctx.root)}`); }
    if (stat.isDirectory()) return fail(`${displayPath(abs, ctx.root)} is a directory — use list_dir.`);
    if (stat.size > MAX_READ_BYTES) return fail(`File is ${(stat.size / 1048576).toFixed(1)} MB; too large to read. Use grep_files to find the relevant part.`);
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) return fail('That file is binary and cannot be read as text.');
    const lines = buf.toString('utf8').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const offset = Math.max(1, Math.floor(Number(input.offset) || 1));
    const limit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(Number(input.limit) || MAX_READ_LINES)));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length).length;
    const body = slice.map((l, i) => {
      const line = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… [line truncated]` : l;
      return `${String(offset + i).padStart(width)}|${line}`;
    }).join('\n');
    ctx.readState.set(abs, stat.mtimeMs);
    const end = offset + slice.length - 1;
    const more = end < lines.length ? `\n\n[Showing lines ${offset}-${end} of ${lines.length}. Use offset/limit to read more.]` : '';
    if (slice.length === 0) return { content: `(the file has ${lines.length} lines; nothing at line ${offset})`, display: 'Empty range' };
    return { content: body + more, display: `Read ${slice.length} line${slice.length === 1 ? '' : 's'}` };
  },
};

function staleCheck(abs: string, ctx: ToolContext): string | null {
  const seen = ctx.readState.get(abs);
  if (seen === undefined) return 'Read the file with read_file before changing it. Edits to a file not read in this session are refused.';
  try {
    if (fs.statSync(abs).mtimeMs !== seen) return 'The file changed on disk since you read it. Read it again before editing.';
  } catch { /* deleted since: let the write recreate it */ }
  return null;
}

function writeAndRecord(abs: string, content: string, ctx: ToolContext): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  ctx.readState.set(abs, fs.statSync(abs).mtimeMs);
}

const writeFile: Tool = {
  name: 'write_file',
  label: 'Write',
  readOnly: false,
  description: 'Create a file, or replace an existing file entirely. Parent directories are created. '
    + 'For a change to part of an existing file use edit_file instead. Overwriting an existing file requires having read it first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project root or absolute.' },
      content: { type: 'string', description: 'The complete file content.' },
    },
    required: ['path', 'content'],
  },
  summary: (i, root) => displayPath(resolvePath(root, i.path), root),
  async run(input, ctx) {
    if (typeof input.content !== 'string') return fail('write_file needs "content" as a string.');
    const abs = resolvePath(ctx.root, input.path);
    const exists = fs.existsSync(abs);
    if (exists && fs.statSync(abs).isDirectory()) return fail('That path is a directory.');
    let old = '';
    if (exists) {
      const stale = staleCheck(abs, ctx);
      if (stale) return fail(stale);
      old = fs.readFileSync(abs, 'utf8');
    }
    const diff = exists ? unifiedDiff(old, input.content) : additionsOnly(input.content, { maxLines: 60 });
    if (exists && !diff) return { content: 'No change: the file already has exactly that content.', display: 'No change' };
    const rel = displayPath(abs, ctx.root);
    const verdict = await ctx.permissions.check({
      kind: 'edit', title: `${exists ? 'Overwrite' : 'Create'} ${rel}`, detail: diff, outsideRoot: !isInsideRoot(abs, ctx.root),
    });
    if (!verdict.ok) return fail(verdict.message);
    writeAndRecord(abs, input.content, ctx);
    const lines = countLines(input.content);
    return {
      content: `${exists ? 'Updated' : 'Created'} ${rel} (${lines} lines).`,
      display: exists ? `Updated ${rel} ${diffStat(diff)}` : `Created ${rel} (${lines} lines)`,
    };
  },
};

const editFile: Tool = {
  name: 'edit_file',
  label: 'Edit',
  readOnly: false,
  description: 'Replace an exact string in a file. old_str must match the file byte for byte (whitespace and indentation included, without the "42|" prefixes read_file adds) '
    + 'and must appear exactly once unless replace_all is true — include enough surrounding lines to make it unique. The file must have been read first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project root or absolute.' },
      old_str: { type: 'string', description: 'The exact text to replace.' },
      new_str: { type: 'string', description: 'The replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' },
    },
    required: ['path', 'old_str', 'new_str'],
  },
  summary: (i, root) => displayPath(resolvePath(root, i.path), root),
  async run(input, ctx) {
    if (typeof input.old_str !== 'string' || typeof input.new_str !== 'string') return fail('edit_file needs "old_str" and "new_str" as strings.');
    let oldStr: string = input.old_str, newStr: string = input.new_str;
    if (oldStr === '') return fail('old_str is empty. To create a file use write_file.');
    if (oldStr === newStr) return fail('old_str and new_str are identical; nothing would change.');
    const abs = resolvePath(ctx.root, input.path);
    if (!fs.existsSync(abs)) return fail(`File not found: ${displayPath(abs, ctx.root)}`);
    const stale = staleCheck(abs, ctx);
    if (stale) return fail(stale);
    const text = fs.readFileSync(abs, 'utf8');
    // A CRLF file edited with LF strings: match it the way the file spells it.
    if (!text.includes(oldStr) && text.includes('\r\n') && !oldStr.includes('\r\n')) {
      const crlf = oldStr.replace(/\n/g, '\r\n');
      if (text.includes(crlf)) { oldStr = crlf; newStr = newStr.replace(/\n/g, '\r\n'); }
    }
    const count = text.split(oldStr).length - 1;
    if (count === 0) {
      const prefixed = /^\s*\d+\|/m.test(oldStr) ? ' It looks like old_str still carries read_file\'s "42|" line prefixes; strip them.' : '';
      return fail(`old_str was not found in the file.${prefixed} Re-read the file and copy the text exactly.`);
    }
    if (count > 1 && input.replace_all !== true) {
      return fail(`old_str appears ${count} times. Add surrounding context to make it unique, or set replace_all to true.`);
    }
    const updated = input.replace_all === true ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
    const diff = unifiedDiff(text, updated);
    const rel = displayPath(abs, ctx.root);
    const verdict = await ctx.permissions.check({ kind: 'edit', title: `Edit ${rel}`, detail: diff, outsideRoot: !isInsideRoot(abs, ctx.root) });
    if (!verdict.ok) return fail(verdict.message);
    writeAndRecord(abs, updated, ctx);
    return {
      content: `Edited ${rel}${count > 1 ? ` (${count} replacements)` : ''}.`,
      display: `Updated ${rel} ${diffStat(diff)}`,
    };
  },
};

const listDir: Tool = {
  name: 'list_dir',
  label: 'List',
  readOnly: true,
  description: 'List the entries of one directory (not recursive). Directories end with "/".',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path; defaults to the project root.' } },
  },
  summary: (i, root) => displayPath(resolvePath(root, i.path), root),
  async run(input, ctx) {
    const abs = resolvePath(ctx.root, input.path);
    const outside = await checkOutsideRead(abs, ctx, 'List');
    if (outside) return outside;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return fail(`Not a readable directory: ${displayPath(abs, ctx.root)}`); }
    const names = entries
      .filter(e => e.name !== '.git' && e.name !== '.DS_Store')
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => (Number(b.endsWith('/')) - Number(a.endsWith('/'))) || a.localeCompare(b));
    const shown = names.slice(0, 500);
    const more = names.length > shown.length ? `\n… and ${names.length - shown.length} more` : '';
    return { content: shown.join('\n') + more || '(empty directory)', display: `${names.length} entr${names.length === 1 ? 'y' : 'ies'}` };
  },
};

const globFiles: Tool = {
  name: 'glob_files',
  label: 'Glob',
  readOnly: true,
  description: 'Find files by name pattern ("**/*.ts", "src/**/*.test.js", "*.md"), most recently modified first. '
    + 'A pattern without "/" matches file names at any depth. Skips files the project .gitignore ignores.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern. Supports *, **, ? and {a,b}.' },
      path: { type: 'string', description: 'Directory to search; defaults to the project root.' },
    },
    required: ['pattern'],
  },
  summary: i => String(i.pattern ?? ''),
  async run(input, ctx) {
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) return fail('glob_files needs a "pattern".');
    const dir = resolvePath(ctx.root, input.path);
    const outside = await checkOutsideRead(dir, ctx, 'Search');
    if (outside) return outside;
    const re = globToRegExp(input.pattern.trim());
    const matcher = loadIgnoreMatcher(ctx.root);
    const hits = walkFiles(dir, ctx.root, matcher, ctx.signal)
      .filter(f => re.test(path.relative(dir, f.abs).split(path.sep).join('/')))
      .map(f => ({ rel: f.rel, mtime: (() => { try { return fs.statSync(f.abs).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.mtime - a.mtime);
    if (hits.length === 0) return { content: `No files match ${input.pattern}.`, display: 'No matches' };
    const shown = hits.slice(0, 200).map(h => h.rel);
    const more = hits.length > shown.length ? `\n… ${hits.length - shown.length} more (narrow the pattern)` : '';
    return { content: shown.join('\n') + more, display: `${hits.length} file${hits.length === 1 ? '' : 's'}` };
  },
};

const MAX_GREP_FILE_BYTES = 1024 * 1024;

const grepFiles: Tool = {
  name: 'grep_files',
  label: 'Grep',
  readOnly: true,
  description: 'Search file contents with a JavaScript regular expression. Skips binary files, files over 1 MB and whatever .gitignore ignores. '
    + 'output_mode: "content" (matching lines with path:line, the default), "files_with_matches" (paths only — the cheap way to ask where something is), or "count".',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression (JavaScript syntax).' },
      path: { type: 'string', description: 'File or directory to search; defaults to the project root.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
      case_insensitive: { type: 'boolean' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      context: { type: 'integer', description: 'Lines of context around each match (content mode).' },
    },
    required: ['pattern'],
  },
  summary: i => `"${clip(String(i.pattern ?? ''), 50)}"${i.path ? ` in ${i.path}` : ''}`,
  async run(input, ctx) {
    if (typeof input.pattern !== 'string' || !input.pattern) return fail('grep_files needs a "pattern".');
    let re: RegExp;
    try { re = new RegExp(input.pattern, input.case_insensitive ? 'i' : ''); } catch (err) {
      return fail(`Invalid regular expression: ${(err as Error).message}`);
    }
    const target = resolvePath(ctx.root, input.path);
    const outside = await checkOutsideRead(target, ctx, 'Search');
    if (outside) return outside;
    const mode = input.output_mode === 'files_with_matches' || input.output_mode === 'count' ? input.output_mode : 'content';
    const contextLines = Math.max(0, Math.min(10, Math.floor(Number(input.context) || 0)));
    const globRe = typeof input.glob === 'string' && input.glob.trim() ? globToRegExp(input.glob.trim()) : null;

    let files: WalkEntry[];
    try {
      files = fs.statSync(target).isFile()
        ? [{ abs: target, rel: displayPath(target, ctx.root) }]
        : walkFiles(target, ctx.root, loadIgnoreMatcher(ctx.root), ctx.signal);
    } catch { return fail(`Not found: ${displayPath(target, ctx.root)}`); }
    if (globRe) files = files.filter(f => globRe.test(f.rel));

    const out: string[] = [];
    let matchedFiles = 0, matchedLines = 0;
    const MAX_LINES_OUT = 250;
    for (const f of files) {
      if (ctx.signal.aborted) break;
      let buf: Buffer;
      try {
        if (fs.statSync(f.abs).size > MAX_GREP_FILE_BYTES) continue;
        buf = fs.readFileSync(f.abs);
      } catch { continue; }
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      const hits: number[] = [];
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i);
      if (hits.length === 0) continue;
      matchedFiles++;
      matchedLines += hits.length;
      if (mode === 'files_with_matches') { out.push(f.rel); continue; }
      if (mode === 'count') { out.push(`${f.rel}:${hits.length}`); continue; }
      if (out.length >= MAX_LINES_OUT) continue;
      const shown = new Set<number>();
      for (const h of hits) for (let k = Math.max(0, h - contextLines); k <= Math.min(lines.length - 1, h + contextLines); k++) shown.add(k);
      let prev = -2;
      for (const k of [...shown].sort((a, b) => a - b)) {
        if (contextLines > 0 && prev >= 0 && k > prev + 1) out.push('--');
        const sep = hits.includes(k) ? ':' : '-';
        out.push(`${f.rel}${sep}${k + 1}${sep}${clip(lines[k], 300)}`);
        prev = k;
      }
    }
    if (matchedFiles === 0) return { content: `No matches for /${input.pattern}/ in ${displayPath(target, ctx.root)}.`, display: 'No matches' };
    const truncated = out.length > MAX_LINES_OUT ? `\n… output truncated; narrow the search (path, glob, or files_with_matches).` : '';
    return {
      content: out.slice(0, MAX_LINES_OUT).join('\n') + truncated,
      display: `${matchedLines} match${matchedLines === 1 ? '' : 'es'} in ${matchedFiles} file${matchedFiles === 1 ? '' : 's'}`,
    };
  },
};

const DEFAULT_COMMAND_TIMEOUT = 120_000;
const MAX_COMMAND_TIMEOUT = 600_000;

// The environment a command runs with: this process's, minus the API key the
// CLI authenticates with. A test, a postinstall script or a prompt-injected
// `printenv` would otherwise put the key into the conversation, a CI log or a
// PR comment. The key is whichever variable config.ts takes it from:
// KEDTEC_API_KEY, else OPENAI_API_KEY (which a project's own code may also
// want — set KEDTEC_API_KEY for this CLI and that one is left alone).
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, KEDTEC: '1' };
  delete out.KEDTEC_API_KEY;
  if (!env.KEDTEC_API_KEY?.trim()) delete out.OPENAI_API_KEY;
  return out;
}

export function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ output: string; code: number | null; timedOut: boolean; interrupted: boolean }> {
  return new Promise(resolve => {
    const sh = currentShell();
    const windows = process.platform === 'win32';
    // Detached on POSIX so the whole process group is ours to stop. Not on
    // Windows, where detached means a new console window — there the tree is
    // stopped with taskkill /T instead.
    const detached = !windows;
    const child = spawn(sh.file, sh.args(command), {
      cwd, env: commandEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached, windowsHide: true,
    });
    let output = '';
    let timedOut = false, interrupted = false;
    const append = (d: Buffer) => {
      output += d.toString('utf8');
      // Keep memory bounded on a command that prints forever.
      if (output.length > 4 * MAX_OUTPUT_CHARS) output = output.slice(0, MAX_OUTPUT_CHARS) + output.slice(-2 * MAX_OUTPUT_CHARS);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    // A `npm test` that spawned a watcher must not outlive the call, so the
    // whole tree goes, not just the shell. On Windows child.kill() ends only
    // the shell and leaves its children running.
    const kill = () => {
      if (windows) {
        if (!child.pid) return;
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill()); } catch { child.kill(); }
        return;
      }
      try { if (detached && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { if (detached && child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { interrupted = true; kill(); };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', err => { output += `\n${err.message}`; });
    child.on('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ output, code, timedOut, interrupted });
    });
  });
}

const runCommand: Tool = {
  name: 'run_command',
  label: 'Bash',
  readOnly: false,
  // A getter, so the shell is looked up when the tool is first offered rather
  // than when this module is imported.
  get description() {
    return `Run a shell command in the project root (${shellDescription()}) and return its combined stdout/stderr and exit code. `
    + 'For builds, tests, package managers, git and other programs — not for reading or editing files, which have their own tools. '
    + `No stdin: interactive commands will hang until the timeout (default ${DEFAULT_COMMAND_TIMEOUT / 1000}s, max ${MAX_COMMAND_TIMEOUT / 1000}s). `
    + 'Pass non-interactive flags (e.g. --yes, CI=1). Do not start long-running servers or watchers.';
  },
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      timeout_ms: { type: 'integer', description: `Timeout in milliseconds (max ${MAX_COMMAND_TIMEOUT}).` },
    },
    required: ['command'],
  },
  summary: i => clip(String(i.command ?? ''), 90),
  async run(input, ctx) {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) return fail('run_command needs a "command".');
    const verdict = classifyCommand(command, ctx.root, ctx.root);
    if (!verdict.readOnly) {
      const reach = commandReach(command, ctx.root, ctx.root);
      const warnings: string[] = [];
      if (reach.outside.length > 0) warnings.push(`Reaches outside the project: ${reach.outside.join(', ')}`);
      if (reach.unanalyzable) {
        warnings.push(shellKind() === 'cmd' ? 'Runs in cmd.exe, so the paths it reaches cannot be checked' : 'Uses substitution or quoting that cannot be analysed');
      }
      const risk = assessRisk(command, ctx.root, ctx.root).reason;
      if (risk && ctx.permissions.mode === 'auto') warnings.push(`Auto mode paused: ${risk}`);
      const permission = await ctx.permissions.check({
        kind: 'command', title: `Run: ${clip(command, 70)}`, detail: command, warnings, commandPrefix: commandPrefix(command), risk,
      });
      if (!permission.ok) return fail(ctx.permissions.mode === 'plan' ? `${permission.message} (${verdict.reason})` : permission.message);
    }
    const timeout = Math.max(1000, Math.min(MAX_COMMAND_TIMEOUT, Math.floor(Number(input.timeout_ms) || DEFAULT_COMMAND_TIMEOUT)));
    ctx.status(`Running ${clip(command, 50)}`);
    const started = Date.now();
    const res = await runShell(command, ctx.root, timeout, ctx.signal);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const output = capOutput(res.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd());
    const tailLines = output.split('\n').filter(l => l.trim()).slice(-4);
    const status = res.interrupted ? 'interrupted' : res.timedOut ? `timed out after ${timeout / 1000}s` : `exit ${res.code}`;
    const display = [
      ...tailLines.map(l => clip(l, 160)),
      `${status} · ${secs}s`,
    ].join('\n');
    const content = `${output || '(no output)'}\n\n[${status}]`;
    return { content, isError: res.code !== 0, display };
  },
};

const todoWrite: Tool = {
  name: 'todo_write',
  label: 'Todos',
  readOnly: true,
  description: 'Maintain a checklist for multi-step work. Send the whole list every time (it replaces the previous one). '
    + 'Use it for tasks with 3+ steps; keep exactly one item in_progress while working and mark items completed as soon as they are done.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  summary: () => '',
  async run(input, ctx) {
    if (!Array.isArray(input.todos)) return fail('todo_write needs "todos" as an array.');
    const todos: Todo[] = [];
    for (const t of input.todos as Record<string, unknown>[]) {
      if (!t || typeof t.content !== 'string') continue;
      const status = t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending';
      todos.push({ content: t.content, status });
    }
    ctx.todos.splice(0, ctx.todos.length, ...todos);
    const display = todos.map(t => (t.status === 'completed'
      ? `${c.green('☒')} ${c.gray(t.content)}`
      : t.status === 'in_progress' ? `${c.yellow('◼')} ${c.bold(t.content)}` : `☐ ${t.content}`)).join('\n');
    const done = todos.filter(t => t.status === 'completed').length;
    return { content: `Todo list updated (${done}/${todos.length} completed).`, display: display || '(empty)' };
  },
};

const MAX_QUESTIONS = 4;
const MAX_QUESTION_OPTIONS = 6;

// One question's options as sent: objects with a label, or bare strings — or
// all of that as a JSON string, which some models send.
function parseOptions(raw: unknown): Question['options'] {
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { /* not JSON */ } }
  return (Array.isArray(raw) ? raw as unknown[] : [])
    .map(o => (typeof o === 'string' ? { label: o } : o as { label?: unknown; description?: unknown }))
    .filter(o => o && typeof o.label === 'string' && o.label.trim())
    .map(o => ({ label: (o.label as string).trim(), description: typeof o.description === 'string' && o.description.trim() ? o.description.trim() : undefined }))
    .slice(0, MAX_QUESTION_OPTIONS);
}

const askUser: Tool = {
  name: 'ask_user',
  label: 'Question',
  readOnly: true,
  description: 'Ask the user questions and wait for the answers. The questions are shown as one form, a tab each: the user picks one option per question, or types their own answer. '
    + 'Use it whenever you would otherwise end your reply with questions or a numbered list of choices — never ask in prose. '
    + `Put every question you have in one call (${MAX_QUESTIONS} at most), each with a short "header" for its tab. `
    + 'The menu shows the questions, so do not also write them in your reply. '
    + `Give each 2–${MAX_QUESTION_OPTIONS} short, distinct options, the one you recommend first; do not add an "Other" option, one is always offered. `
    + 'Ask only what you cannot settle from the code or a sensible default.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: `1–${MAX_QUESTIONS} questions.`,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question, ending with a question mark.' },
            header: { type: 'string', description: 'A very short label for its tab, at most 12 characters: "Focus", "Task type".' },
            options: {
              type: 'array',
              description: `The choices, ${MAX_QUESTION_OPTIONS} at most.`,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'The choice, in a few words.' },
                  description: { type: 'string', description: 'Optional: what choosing it means.' },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
  summary: input => (Array.isArray(input.questions) && input.questions.length > 1 ? `${input.questions.length} questions` : ''),
  async run(input, ctx) {
    // Also taken, as models send them: a lone question at the top level, and
    // questions as bare strings (answered by typing).
    const raw = Array.isArray(input.questions) ? input.questions as unknown[] : typeof input.question === 'string' ? [input] : [];
    const questions: Question[] = [];
    for (const item of raw.slice(0, MAX_QUESTIONS)) {
      const q = (typeof item === 'string' ? { question: item } : item) as Record<string, unknown> | null;
      if (!q || typeof q.question !== 'string' || !q.question.trim()) {
        return fail('ask_user needs "questions" as an array of { "question": string, "options": [{ "label": string }] }.');
      }
      const header = typeof q.header === 'string' && q.header.trim() ? q.header.trim() : undefined;
      questions.push({ question: q.question.trim(), header, options: parseOptions(q.options) });
    }
    if (questions.length === 0) return fail('ask_user needs "questions": at least one.');
    if (!ctx.ask) return fail('Nobody can answer questions in this run. Decide on your own judgment and say what you assumed.');
    const result = await ctx.ask(questions);
    if (result.kind === 'dismissed') {
      return { content: 'The user dismissed the questions without answering. Do not ask again; stop and wait for their next message.', display: 'Dismissed' };
    }
    if (result.kind === 'chat') {
      return {
        content: 'The user wants to talk this through rather than pick from the options. Do not call ask_user again now; stop and wait for their next message.',
        display: 'Chose to chat about it',
      };
    }
    const lines = questions.map((q, i) => `"${q.question}" → ${result.answers[i] ?? '(not answered)'}`);
    const display = questions.length === 1
      ? result.answers[0] ?? '(not answered)'
      : questions.map((q, i) => `${q.header ?? q.question} → ${result.answers[i] ?? '(not answered)'}`).join('\n');
    return { content: `The user answered:\n${lines.join('\n')}`, display };
  },
};

// A reply that ends by asking in prose what ask_user should have asked:
//
//   Would you like me to:                       ← the lead: asks, ends in ":" or "?"
//   1. Help you locate the correct project?     ← 2–6 numbered or bulleted items
//   2. Create a sample page?
//
//   Please let me know how you'd like to proceed. ← an optional closing line
//
// Items that are choices become one question's options; items that are each a
// question of their own ("Could you clarify: 1. What …? 2. Are you …?") become
// questions to type answers to. A list that only reports ("Changes: 1. Added
// …") is not a question, and nor is anything with more text after the list.
const ASKS = /\?|\b(would you|do you|should i|shall i|can i|which|what|how|could you|can you|let me know|clarify|prefer|choose|select|want me to|like me to|options?)\b/i;
const QUESTION_START = /^(what|which|who|where|when|why|how|is|are|do|does|did|can|could|should|would|will|have|has)\b/i;
const OPEN_QUESTIONS_LEAD = /\b(clarify|questions?|tell me|know more|understand|details?)\b/i;
const OFFERS_ACTIONS = /\b(would you like|do you want|want me to|like me to|should i|shall i)\b/i;

export function questionsInProse(text: string): Question[] | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd());
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // An optional closing paragraph of one short line, after a blank line.
  let end = lines.length;
  let closing = '';
  const last = lines[end - 1]?.trim() ?? '';
  if (end >= 2 && !/^(\d+[.)]|[-*•])\s/.test(last) && !lines[end - 2].trim() && last.length <= 160) {
    closing = last;
    end -= 2;
  }
  const items: string[] = [];
  let i = end - 1;
  for (; i >= 0; i--) {
    const m = /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/.exec(lines[i]);
    if (!m) break;
    items.unshift(m[1].trim());
  }
  while (i >= 0 && !lines[i].trim()) i--;
  const lead = (lines[i] ?? '').trim().replace(/^[#>*\s]+|\*+$/g, '');
  if (items.length < 2 || items.length > MAX_QUESTION_OPTIONS || !lead || !/[:?]$/.test(lead)) return null;
  if (!ASKS.test(lead) && !(closing && ASKS.test(closing))) return null;

  const plain = (s: string) => s.replace(/\*\*|__|`/g, '').trim();
  const open = !OFFERS_ACTIONS.test(lead) && items.every(it => plain(it).endsWith('?') && QUESTION_START.test(plain(it)));
  if (open) {
    if (!OPEN_QUESTIONS_LEAD.test(lead) && !lead.endsWith('?')) return null;
    return items.slice(0, MAX_QUESTIONS).map((it, n) => ({ question: plain(it), header: `Q${n + 1}`, options: [] }));
  }
  const options = items.map(it => {
    // "**Label** — what it means", "Label: what it means"
    const m = /^\*\*(.+?)\*\*\s*[:—–-]?\s*(.*)$/.exec(it) ?? /^([^:—–]{2,40})\s*[:—–]\s+(.+)$/.exec(it);
    const label = plain(m ? m[1] : it).replace(/[?.]$/, '');
    const description = m && m[2] ? plain(m[2]) : undefined;
    return { label, description };
  });
  const question = lead.endsWith('?') ? lead : `${lead.replace(/:$/, '')}…`;
  return [{ question, options }];
}

export const TOOLS: Tool[] = [readFile, writeFile, editFile, listDir, globFiles, grepFiles, runCommand, todoWrite, askUser];

export function toolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function findTool(name: string): Tool | undefined {
  return TOOLS.find(t => t.name === name);
}
