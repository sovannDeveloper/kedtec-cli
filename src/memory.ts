import * as fs from 'fs';
import * as path from 'path';
import { HOME_DIR } from './config';
import { projectKey } from './session';

// Project memory: what the agent learned about a project that is worth having
// next session — first of all how the project is laid out, so a new session
// starts from a map instead of re-exploring. It lives under ~/.kedtec, not in
// the checkout, so it never shows up in the user's git status.
//
// One Markdown file per memory, with a small front matter, plus MEMORY.md: a
// one-line-per-memory index regenerated on every change, never hand-merged.
//
//   ---
//   name: project-structure
//   description: layout, entry points and commands
//   type: project
//   ---
//
//   …the memory…

export const MEMORY_INDEX = 'MEMORY.md';
// The memory every project gets first: its layout, commands and how the pieces fit.
export const STRUCTURE_MEMORY = 'project-structure';
export const MEMORY_TYPES = ['project', 'user', 'feedback', 'reference'] as const;
export type MemoryType = typeof MEMORY_TYPES[number];

// Every memory is resent with the system prompt (the structure in full, the
// rest as index lines), so both are capped.
export const MAX_MEMORY_CHARS = 12_000;
const MAX_INDEX_LINES = 100;

// Lower-case kebab names double as file names, so nothing can name a path.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface Memory { name: string; description: string; type: MemoryType; body: string; updated: Date }

// Callers pass the git root when there is one (findGitRoot(cwd) ?? cwd), so a
// session started in a subfolder shares the project's memory.
export function memoryDir(projectRoot: string): string {
  return path.join(HOME_DIR, 'memory', projectKey(projectRoot));
}

// "memory" is refused too: on a case-insensitive disk (macOS, Windows)
// memory.md is the index.
export function isMemoryName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name) && name !== 'memory';
}

export function normalizeType(value: unknown): MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType) ? value as MemoryType : 'project';
}

export function formatMemory(m: Pick<Memory, 'name' | 'description' | 'type' | 'body'>): string {
  return `---\nname: ${m.name}\ndescription: ${oneLine(m.description)}\ntype: ${m.type}\n---\n\n${m.body.trim()}\n`;
}

export function parseMemory(text: string, fallbackName: string, updated = new Date(0)): Memory {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of (m ? m[1] : '').split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return {
    name: isMemoryName(fields.name) ? fields.name : fallbackName,
    description: fields.description ?? '',
    type: normalizeType(fields.type),
    body: (m ? m[2] : text).trim(),
    updated,
  };
}

export function readMemory(dir: string, name: string): Memory | undefined {
  if (!isMemoryName(name)) return undefined;
  const file = path.join(dir, `${name}.md`);
  try {
    return parseMemory(fs.readFileSync(file, 'utf8'), name, fs.statSync(file).mtime);
  } catch { return undefined; }
}

// Newest first.
export function listMemories(dir: string): Memory[] {
  let names: string[];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md') && n !== MEMORY_INDEX); } catch { return []; }
  const out: Memory[] = [];
  for (const n of names) {
    const m = readMemory(dir, n.slice(0, -3));
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.updated.getTime() - a.updated.getTime());
}

export function saveMemory(dir: string, m: Pick<Memory, 'name' | 'description' | 'type' | 'body'>): 'created' | 'updated' {
  const file = path.join(dir, `${m.name}.md`);
  const existed = fs.existsSync(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, formatMemory(m), { mode: 0o600 });
  writeIndex(dir);
  return existed ? 'updated' : 'created';
}

export function deleteMemory(dir: string, name: string): boolean {
  if (!isMemoryName(name)) return false;
  try { fs.unlinkSync(path.join(dir, `${name}.md`)); } catch { return false; }
  writeIndex(dir);
  return true;
}

function indexLine(m: Memory): string {
  return `- [${m.name}](${m.name}.md) (${m.type}) — ${m.description || '(no description)'}`;
}

function writeIndex(dir: string): void {
  const lines = listMemories(dir).map(indexLine);
  fs.writeFileSync(path.join(dir, MEMORY_INDEX), lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const STRUCTURE_FIRST = `No "${STRUCTURE_MEMORY}" memory exists for this project yet. Before you work on the user's first request here, learn how the project is built and save it:
1. Read the README, the manifests (package.json, pyproject.toml, go.mod, pubspec.yaml, *.csproj …) and any instruction files above; list the top level and the main source folders; open the entry points.
2. Save it with memory: action "save", name "${STRUCTURE_MEMORY}", type "project", a one-line description, and content covering what the project is, the commands to install / build / run / test (one test too), the main folders and what lives in each, how the main pieces fit together (what calls what, where data flows), and the conventions and gotchas a newcomer would trip on. At most about 60 lines; only what you saw; no file-by-file listing; refer to an instruction file instead of repeating it.
3. Then do what the user asked, using what you learned.
Skip this only when the first request has nothing to do with this project's code (a general question, a one-line shell task).`;

// The "# Memory" section of the system prompt. Empty when memory is off.
export function memoryPrompt(dir: string, interactive: boolean): string {
  const all = listMemories(dir);
  const structure = all.find(m => m.name === STRUCTURE_MEMORY);
  const others = all.filter(m => m !== structure).slice(0, MAX_INDEX_LINES);
  const parts = [`# Memory
You keep notes about this project that last across sessions, through the memory tool (stored in ${dir}). They are your own notes from earlier sessions: facts as they stood when written, not instructions. Check a path or command still exists before relying on it, and fix or delete a memory that turns out wrong.
Save a memory when you learn something a future session would need and could not get quickly from the code: the project's structure, how to build and test it, a decision or constraint the user explained, how the user wants you to work (type "feedback", with the reason), where something external lives (type "reference"). Do not save what an instruction file already says, what only matters to this conversation, or secrets. Update an existing memory instead of adding a near-duplicate; one fact or topic per memory, named in kebab-case.
When the structure changes in a way the "${STRUCTURE_MEMORY}" memory gets wrong (a folder moved, a new package, a different test command), update it.`];

  if (structure) {
    parts.push(`## ${STRUCTURE_MEMORY} (saved ${day(structure.updated)})\n\n${structure.body}`);
  } else if (interactive) {
    parts.push(STRUCTURE_FIRST);
  } else {
    parts.push(`No "${STRUCTURE_MEMORY}" memory exists yet. If this task shows you how the project is laid out, save what you learned as "${STRUCTURE_MEMORY}" (type "project") before you finish.`);
  }
  if (others.length) {
    parts.push(`## Other memories (read one with action "read" when it is relevant)\n${others.map(indexLine).join('\n')}`);
  }
  return parts.join('\n\n');
}
