import * as fs from 'fs';
import * as path from 'path';
import { loadIgnoreMatcher } from './ignore';
import { isImagePath } from './images';
import { displayPath, isInsideRoot, listProjectFiles } from './tools';

// "@path" mentions: the files a message names, attached to it, and the paths to
// suggest while one is being typed.

const MAX_MENTION_SUGGESTIONS = 50;
// How long the project's file list is reused between @ completions.
const FILE_LIST_TTL_MS = 30_000;

// The paths to offer for what follows an "@": the entries of the folder being
// typed into, then (for a bare name) project files whose name or path contains
// it. Ignored files are left out, as the search tools leave them out. The CLI's
// input box and the VS Code chat panel both ask this.
// The file list is built in the background and never waited for: a call uses
// the list as it last stood, and `onListed` says when a fresh one arrived, so
// the suggestions on screen can be asked for again.
export function makeMentionFinder(root: string, onListed?: () => void): (query: string) => string[] {
  let files: string[] = [];
  let listedAt = 0;
  let listing = false;
  const projectFiles = () => {
    if (!listing && Date.now() - listedAt > FILE_LIST_TTL_MS) {
      listing = true;
      void listProjectFiles(root)
        .then(list => { files = list; onListed?.(); }, () => { /* keep the old list */ })
        .finally(() => { listing = false; listedAt = Date.now(); });
    }
    return files;
  };

  const mentions = (query: string): string[] => {
    const slash = query.lastIndexOf('/');
    const dirPart = query.slice(0, slash + 1);
    const prefix = query.slice(slash + 1).toLowerCase();
    const out: string[] = [];
    const dirAbs = path.resolve(root, dirPart || '.');
    if (isInsideRoot(dirAbs, root)) {
      const matcher = loadIgnoreMatcher(root);
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { /* not a folder (yet) */ }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name === '.git' || !e.name.toLowerCase().startsWith(prefix)) continue;
        const rel = path.relative(root, path.join(dirAbs, e.name)).split(path.sep).join('/');
        if (matcher.isIgnored(rel, e.isDirectory())) continue;
        out.push(`${dirPart}${e.name}${e.isDirectory() ? '/' : ''}`);
      }
    }
    if (prefix && !dirPart) {
      const all = projectFiles();
      const byName = all.filter(f => path.posix.basename(f).toLowerCase().includes(prefix));
      const byPath = all.filter(f => f.toLowerCase().includes(prefix));
      for (const f of [...byName, ...byPath]) {
        if (out.length >= MAX_MENTION_SUGGESTIONS) break;
        if (!out.includes(f)) out.push(f);
      }
    }
    return out.slice(0, MAX_MENTION_SUGGESTIONS);
  };

  return mentions;
}

// The KEDTec API refuses a message over 100,000 characters (a 422), so what the
// mentions attach shares this budget, leaving room for the typed text and an
// editor selection (up to 20,000). A file over it is named, not attached.
const MAX_ATTACH_CHARS = 60_000;
// A range picks lines out of a file too big to attach whole; the lines picked
// still come out of MAX_ATTACH_CHARS.
const MAX_RANGED_FILE_BYTES = 10 * 1024 * 1024;

// "src/app.ts#L10-20", "src/app.ts#L10", "src/app.ts:10-20" → the file and its
// lines. This is how a selection reaches the model from a terminal with no
// editor bridge behind it (Android Studio, Xcode, a plain shell).
export function parseMention(raw: string): { file: string; start?: number; end?: number } {
  const m = /^(.+?)(?:#L?(\d+)(?:-L?(\d+))?|:(\d+)(?:-(\d+))?)$/.exec(raw);
  if (!m) return { file: raw };
  const a = Math.max(1, Number(m[2] ?? m[4]));
  const b = Math.max(1, Number(m[3] ?? m[5] ?? a));
  return { file: m[1], start: Math.min(a, b), end: Math.max(a, b) };
}

// "@src/app.ts" → the file's text, attached to the message; "@src/app.ts#L10-20"
// (or "@src/app.ts #10-20", the range as the next word) → just those lines.
// Only files inside the project, and the read counts as a read for the edit
// guard, as read_file with offset/limit does. A file too big to carry is left
// out and listed in `skipped`; its name stays in the text for the model to read.
// An image ("@shot.png") is not read here but listed in `images`, to go with
// the message as an image.
export function expandMentions(text: string, root: string, readState: Map<string, number>): { text: string; attached: string[]; skipped: string[]; images: { path: string; label: string }[] } {
  const attached: string[] = [];
  const skipped: string[] = [];
  const images: { path: string; label: string }[] = [];
  const blocks: string[] = [];
  let budget = MAX_ATTACH_CHARS;
  for (const m of text.matchAll(/(^|\s)@([^\s@]+)(?:[ \t]+(#L?\d+(?:-L?\d+)?)(?=[\s.,;:!?)]|$))?/g)) {
    let raw = m[2].replace(/[.,;:!?)]+$/, '');
    if (m[3] && parseMention(raw).start === undefined) raw += m[3];
    const { file, start, end } = parseMention(raw);
    const abs = path.resolve(root, file);
    const rel = displayPath(abs, root);
    const label = start === undefined ? rel : start === end ? `${rel}:${start}` : `${rel}:${start}-${end}`;
    if (!isInsideRoot(abs, root) || attached.includes(label)) continue;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      if (isImagePath(abs)) {
        if (!images.some(img => img.path === abs)) images.push({ path: abs, label: rel });
        continue;
      }
      if (st.size > (start === undefined ? MAX_ATTACH_CHARS : MAX_RANGED_FILE_BYTES)) {
        skipped.push(`${label} (${st.size.toLocaleString('en-US')} bytes)`);
        continue;
      }
      const body = fs.readFileSync(abs, 'utf8');
      if (body.includes('\u0000')) continue;
      const lines = body.split('\n');
      const first = start ?? 1;
      const last = Math.min(end ?? lines.length, lines.length);
      if (first > last) continue;
      const numbered = lines.slice(first - 1, last).map((l, i) => `${first + i}|${l}`).join('\n');
      if (numbered.length > budget) {
        skipped.push(`${label} (${numbered.length.toLocaleString('en-US')} characters)`);
        continue;
      }
      budget -= numbered.length;
      const lineAttr = start === undefined ? '' : ` lines="${first}-${last}" total="${lines.length}"`;
      blocks.push(`<file path="${rel}"${lineAttr}>\n${numbered}\n</file>`);
      attached.push(label);
      readState.set(abs, st.mtimeMs);
    } catch { /* not a file: leave the text alone */ }
  }
  if (blocks.length === 0) return { text, attached, skipped, images };
  return { text: `${text}\n\nAttached files (line-numbered as read_file returns them):\n\n${blocks.join('\n\n')}`, attached, skipped, images };
}
