import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The editor this terminal sits under, as reported by the KEDTec VS Code
// extension (src/cliBridge.ts there): the file open in that window and what is
// selected in it. Each window writes ~/.kedtec/ide/<extension-host pid>.json;
// this picks the one whose workspace contains the project, from a window that
// is still running.

export interface IdeRange { startLine: number; endLine: number; text: string }

export interface IdeState {
  pid: number;
  workspaceFolders: string[];
  file: string | null;
  // The primary selection only; an extension older than `selections` sends just this.
  selection: IdeRange | null;
  // Every selection (alt+click and ctrl+d make several), top to bottom.
  selections?: IdeRange[];
  updated: number;
}

// What is selected, all of it: `selections` when the extension sends it, else
// the one primary selection. Reading `selection` alone is how a second range
// selected with alt+click never reached the model.
export function selectedRanges(state: IdeState | null): IdeRange[] {
  if (!state) return [];
  const all = Array.isArray(state.selections) ? state.selections : state.selection ? [state.selection] : [];
  return all.filter(r => r && typeof r.text === 'string' && r.text.trim());
}

function lineCount(ranges: IdeRange[]): number {
  return ranges.reduce((n, r) => n + r.endLine - r.startLine + 1, 0);
}

// KEDTEC_IDE_DIR exists for tests; the extension always writes to ~/.kedtec/ide.
const IDE_DIR = process.env.KEDTEC_IDE_DIR || path.join(os.homedir(), '.kedtec', 'ide');
const POLL_MS = 1500;

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

export class IdeWatcher {
  state: IdeState | null = null;
  private watcher: fs.FSWatcher | undefined;
  private poll: NodeJS.Timeout | undefined;
  private key = '';

  constructor(private readonly root: string, private readonly onChange: (state: IdeState | null) => void) {}

  start(): void {
    this.read();
    // fs.watch is fast but can miss a rename or stop on some filesystems; the
    // poll is the backstop, and it also notices a window that has closed.
    try {
      fs.mkdirSync(IDE_DIR, { recursive: true, mode: 0o700 });
      this.watcher = fs.watch(IDE_DIR, () => this.read());
    } catch { /* polling alone still works */ }
    this.poll = setInterval(() => this.read(), POLL_MS);
    this.poll.unref();
  }

  stop(): void {
    this.watcher?.close();
    if (this.poll) clearInterval(this.poll);
  }

  private read(): void {
    let best: IdeState | null = null;
    let names: string[] = [];
    try { names = fs.readdirSync(IDE_DIR).filter(n => n.endsWith('.json')); } catch { /* no extension yet */ }
    for (const name of names) {
      let s: IdeState;
      try { s = JSON.parse(fs.readFileSync(path.join(IDE_DIR, name), 'utf8')); } catch { continue; }
      if (!s || typeof s.pid !== 'number' || !Array.isArray(s.workspaceFolders) || !alive(s.pid)) continue;
      const matches = s.workspaceFolders.some(f => inside(this.root, f) || inside(f, this.root));
      if (matches && (!best || s.updated > best.updated)) best = s;
    }
    const key = best ? `${best.file}|${selectedRanges(best).map(r => `${r.startLine}-${r.endLine}:${r.text.length}`).join(',')}` : '';
    if (key === this.key) return;
    this.key = key;
    this.state = best;
    this.onChange(best);
  }
}

// "⧉ In ui.ts", "⧉ 12 lines selected" or "⧉ 18 lines in 2 selections", for the status line.
export function ideLabel(state: IdeState | null): string {
  if (!state?.file) return '';
  const ranges = selectedRanges(state);
  if (ranges.length) {
    const n = lineCount(ranges);
    const lines = `${n} line${n === 1 ? '' : 's'}`;
    return ranges.length === 1 ? `⧉ ${lines} selected` : `⧉ ${lines} in ${ranges.length} selections`;
  }
  return `⧉ In ${path.basename(state.file)}`;
}

// What the editor adds to a message: the selection when there is one, else a
// note naming the open file. Returned only when it differs from what was last
// sent, so the same selection is not attached to every message after it.
export class IdeContext {
  private lastSent = '';

  constructor(private readonly root: string) {}

  forMessage(state: IdeState | null): { text: string; note: string } | null {
    if (!state?.file) return null;
    const rel = inside(state.file, this.root) ? path.relative(this.root, state.file) : state.file;
    const ranges = selectedRanges(state);
    const digest = crypto.createHash('sha1')
      .update(`${state.file}\0${ranges.map(r => `${r.startLine}-${r.endLine}\0${r.text}`).join('\0')}`).digest('hex');
    if (digest === this.lastSent) return null;
    this.lastSent = digest;
    if (ranges.length) {
      const blocks = ranges.map(r => {
        const lines = r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}-${r.endLine}`;
        return `<ide_selection file="${rel}" lines="${lines}">\n${r.text}\n</ide_selection>\n`;
      }).join('');
      const n = lineCount(ranges);
      const where = ranges.length === 1 ? '' : ` (${ranges.length} selections)`;
      return {
        text: blocks + (ranges.length === 1
          ? 'The user selected these lines in their editor. They may be what this message is about.'
          : `The user made ${ranges.length} separate selections in their editor; all of them may be what this message is about.`),
        note: `⧉ Selected ${n} lines from ${path.basename(state.file)}${where}`,
      };
    }
    return {
      text: `<ide_opened_file>The user has ${rel} open in their editor. This may or may not be related to this message.</ide_opened_file>`,
      note: '',
    };
  }
}
