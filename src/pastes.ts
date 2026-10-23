import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Long text pasted into the input box is saved to a temp file and stands in
// the box as "[Pasted text #1 +40 lines]", so the box stays a few rows tall
// and the text reaches the model exactly as it was pasted. When the message is
// sent the text goes back in place of its placeholder; past
// MAX_INLINE_PASTE_CHARS the model gets the file's path instead, to read in
// parts with read_file (which reads it without asking, see isPasteFile).

const LONG_PASTE_CHARS = 1000;
const LONG_PASTE_LINES = 10;
const MAX_INLINE_PASTE_CHARS = 60_000;

export interface PastedText {
  text: string;
  path: string;
  lines: number;
}

export function isLongPaste(text: string): boolean {
  return text.length > LONG_PASTE_CHARS || text.split('\n').length > LONG_PASTE_LINES;
}

// One folder per run, made on the first long paste.
let dir: string | null = null;

// The pasted text in a file of its own, or why it could not be saved.
export function savePaste(text: string): PastedText | string {
  try {
    dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'kedtec-paste-'));
    const file = path.join(dir, `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    return { text, path: file, lines: text.split('\n').length };
  } catch (err) {
    return (err as Error).message;
  }
}

// A file this run saved a paste to: the model may read it as if it were in
// the project.
export function isPasteFile(abs: string): boolean {
  if (!dir) return false;
  const rel = path.relative(dir, path.resolve(abs));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

export function pasteTag(n: number, p: PastedText): string {
  return `[Pasted text #${n} +${p.lines} line${p.lines === 1 ? '' : 's'}]`;
}

// The message with each placeholder (its first one) replaced by its text, or
// by where to read it when it is too long to carry, counting all the pastes in
// the message against one budget.
export function withPastes(text: string, pastes: Map<number, PastedText> | undefined): string {
  if (!pastes?.size) return text;
  let budget = MAX_INLINE_PASTE_CHARS;
  const placed = new Set<number>();
  return text.replace(/\[Pasted text #(\d+) \+\d+ lines?\]/g, (tag, num: string) => {
    const n = Number(num);
    const p = pastes.get(n);
    if (!p || placed.has(n) || tag !== pasteTag(n, p)) return tag;
    placed.add(n);
    if (p.text.length <= budget) {
      budget -= p.text.length;
      return p.text;
    }
    return `[Pasted text #${n}: ${p.lines} lines, ${p.text.length.toLocaleString('en-US')} characters — too long to include here, saved at ${p.path}. Read it with read_file, in parts (offset/limit) if needed.]`;
  });
}
