import * as readline from 'readline';
import { AskResult, HISTORY_SIZE, Prompter, expectReport, installInputFilter, keyStream, loadHistory, saveHistory } from './input';
import { stripAnsi } from './ui';

// The interactive screen, full-screen like an editor: the conversation in a
// view of its own, and fixed at the bottom the loading line, the input box and
// the mode/status line. Only the conversation scrolls.
//
//   ╭ KEDTec CLI …                       ┐
//   ● Fixed add in math.js …             │ conversation — mouse wheel, PgUp/PgDn
//   ✻ Baked for 8s                       ┘
//   ✻ Thinking… (4s · ↓ 1.2k tokens)     loading line (blank when idle)
//   ──────────────────────────────
//   ❯ the input, as many rows as it wraps to
//   ──────────────────────────────
//     ⏵⏵ accept edits on …   ⧉ In ui.ts · ● model
//
// A terminal's own scrollback cannot do this — scrolling it moves everything
// on screen, the input box with it — so the screen runs on the alternate
// buffer and draws every row itself. Output is not written to the terminal at
// all: every write to stdout lands in a model of the conversation (Transcript
// below), wrapped to the current width, and the frame shows a slice of it. On
// exit the alternate buffer is left and the whole conversation is printed
// once, so it ends up in the terminal's history like any other output.
//
// Wheel events need mouse reporting, which takes plain drag-to-select away
// from the terminal; /mouse turns it off (PgUp/PgDn still scroll), and most
// terminals select with a modifier while it is on (Shift, or Option on a Mac
// with VS Code's terminal.integrated.macOptionClickForcesSelection).
//
// readline is not used for the input: it edits a line at the cursor. This is a
// small line editor of its own, which also buys bracketed paste (a pasted
// block arrives as one message, with its newlines) and an input that grows as
// it wraps.

const RESIZE_SETTLE_MS = 50;
const MAX_TRANSCRIPT_LINES = 20_000;
const WHEEL_ROWS = 3;

// Display width of one grapheme, the way a terminal advances its cursor: the
// sum over code points, combining marks and format characters counting 0 and
// East Asian wide characters and emoji counting 2. A Khmer cluster with a
// subscript consonant is base + coeng (0) + consonant (1), so 2 — as wcwidth,
// and therefore the terminal, sees it.
function codePointWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  const ch = String.fromCodePoint(cp);
  if (/[\p{Mn}\p{Me}\p{Cf}]/u.test(ch)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

function graphemeWidth(g: string): number {
  let w = 0;
  for (const ch of g) w += codePointWidth(ch.codePointAt(0)!);
  return w;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Grapheme boundaries of `text` as string offsets, including 0 and length.
function boundaries(text: string): number[] {
  const out = [0];
  for (const s of segmenter.segment(text)) out.push(s.index + s.segment.length);
  return out;
}

interface Keypress { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }


// One logical line, possibly coloured, cut into rows of at most `width`
// columns. A colour that spans a cut is closed at the end of the row and
// reopened at the start of the next, so each row draws correctly on its own.
function wrapAnsi(line: string, width: number): string[] {
  const rows: string[] = [];
  let row = '';
  let w = 0;
  let sgr = '';
  for (const m of line.replace(/\t/g, '    ').matchAll(/(\x1b\[[0-9;]*m)|([^\x1b]+)|\x1b/g)) {
    if (m[1]) {
      row += m[1];
      sgr = m[1] === '\x1b[0m' || m[1] === '\x1b[m' ? '' : sgr + m[1];
      continue;
    }
    if (!m[2]) continue;
    for (const { segment } of segmenter.segment(m[2])) {
      const gw = graphemeWidth(segment);
      if (w + gw > width && w > 0) {
        rows.push(row + '\x1b[0m');
        row = sgr;
        w = 0;
      }
      row += segment;
      w += gw;
    }
  }
  rows.push(row);
  return rows;
}

// The conversation as lines, built from what the program writes. Only what
// that output actually contains is understood: text, colour, newlines, a
// carriage return or "erase line" starting a line over, and "cursor up" — the
// approval menu redraws its options in place with it.
class Transcript {
  lines: string[] = [''];
  private cur = 0;
  // Wrapped rows per line, for the width in `wrapWidth`.
  private cache: (string[] | undefined)[] = [];
  private wrapWidth = 0;

  write(text: string): void {
    const re = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b.?|\r\n|\r|\n|[^\x1b\r\n]+/g;
    for (const m of text.matchAll(re)) {
      const tok = m[0];
      if (m[2]) {
        if (m[2] === 'm') this.append(tok);
        else if (m[2] === 'A') this.cur = Math.max(0, this.cur - (Number(m[1]) || 1));
        else if (m[2] === 'K' && m[1] === '2') this.set('');
      } else if (tok === '\n' || tok === '\r\n') {
        this.cur++;
        if (this.cur === this.lines.length) this.lines.push('');
      } else if (tok === '\r') {
        this.set('');
      } else if (!tok.startsWith('\x1b')) {
        this.append(tok);
      }
    }
    if (this.lines.length > MAX_TRANSCRIPT_LINES) {
      const drop = this.lines.length - MAX_TRANSCRIPT_LINES;
      this.lines.splice(0, drop);
      this.cache.splice(0, drop);
      this.cur = Math.max(0, this.cur - drop);
    }
  }

  private append(s: string): void { this.lines[this.cur] += s; this.cache[this.cur] = undefined; }
  private set(s: string): void { this.lines[this.cur] = s; this.cache[this.cur] = undefined; }

  // Every row to display at `width`. The empty line the cursor sits on after a
  // final newline is not content.
  rows(width: number): string[] {
    if (width !== this.wrapWidth) { this.cache = []; this.wrapWidth = width; }
    const n = this.lines.length - (this.cur === this.lines.length - 1 && this.lines[this.cur] === '' ? 1 : 0);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      let rows = this.cache[i];
      if (!rows) this.cache[i] = rows = wrapAnsi(this.lines[i], width);
      for (const r of rows) out.push(r);
    }
    return out;
  }

  // The conversation as plain output, for the terminal's history at exit.
  text(): string {
    const n = this.lines.length - (this.lines[this.lines.length - 1] === '' ? 1 : 0);
    return this.lines.slice(0, n).join('\n');
  }

  clear(): void {
    this.lines = [''];
    this.cur = 0;
    this.cache = [];
  }
}

export class Screen implements Prompter {
  private active = false;
  private readonly out = process.stdout;
  private readonly rawWrite = process.stdout.write.bind(process.stdout);
  private readonly transcript = new Transcript();

  private statusLeft = '';
  // Pieces of the right side, most important first; the tail is dropped when
  // the row is too narrow for all of them.
  private statusRight: string[] = [];

  private editing = false;
  private prompt = '> ';
  private text = '';
  private cursor = 0; // string offset, always on a grapheme boundary
  private secret = false;
  private placeholder = '';

  private history: string[] = loadHistory();
  // Slash commands, for Tab completion.
  completions: string[] = [];
  // shift+tab while editing (the permission-mode cycle).
  onShiftTab?: () => void;
  // The loading line above the input box.
  private activity = '';

  // Rows scrolled up from the bottom of the conversation; 0 follows new output.
  private scroll = 0;
  private lastTotal = 0;
  private viewHeight = 1;
  // What is on screen, row by row, so a frame only rewrites what changed.
  private frame: string[] = [];
  private mouse = process.env.KEDTEC_MOUSE !== '0';
  private resizeTimer: NodeJS.Timeout | undefined;

  private readonly onResize = () => {
    if (!this.active) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      // The size just reported is the one to distrust least, until measured.
      this.size = null;
      void this.measure().then(m => { if (m) this.size = m; this.redraw(); });
    }, RESIZE_SETTLE_MS);
  };

  static supported(): boolean {
    return !!process.stdout.isTTY && !!process.stdin.isTTY && (process.stdout.rows ?? 0) >= 12
      && process.env.TERM !== 'dumb' && process.env.KEDTEC_STATUSBAR !== '0';
  }

  // The terminal's real size, measured (see measure()). Until it is known, the
  // size the terminal reported to the process.
  private size: { rows: number; cols: number } | null = null;
  private get rows(): number { return this.size?.rows || this.out.rows || 24; }
  private get cols(): number { return this.size?.cols || this.out.columns || 80; }

  // Ask the terminal how big it is: park the cursor at row 999, column 999 —
  // which it clamps to its last row and column — and request a cursor position
  // report, between a cursor save and restore. This exists because the size a
  // process is told can be stale: VS Code passes a panel resize to the pty
  // lazily, and a frame laid out for 40 rows on a 30-row screen puts the input
  // box below the bottom edge. A terminal that does not answer leaves the
  // reported size in force after the timeout.
  measure(timeoutMs = 400): Promise<{ rows: number; cols: number } | null> {
    const stdin = process.stdin;
    if (!stdin.isTTY || !this.out.isTTY) return Promise.resolve(null);
    return new Promise(resolve => {
      const wasRaw = !!stdin.isRaw;
      const wasPaused = stdin.isPaused();
      let buf = '';
      let timer: NodeJS.Timeout | undefined;
      const done = (v: { rows: number; cols: number } | null) => {
        if (timer) clearTimeout(timer);
        stdin.off('data', onData);
        if (!wasRaw) stdin.setRawMode(false);
        if (wasPaused) stdin.pause();
        resolve(v);
      };
      const onData = (d: Buffer) => {
        buf += d.toString('latin1');
        const m = /\x1b\[(\d+);(\d+)R/.exec(buf);
        if (m) done({ rows: Number(m[1]), cols: Number(m[2]) });
      };
      timer = setTimeout(() => done(null), timeoutMs);
      if (!wasRaw) stdin.setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
      expectReport();
      this.rawWrite('\x1b7\x1b[999;999H\x1b[6n\x1b8');
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async enable(): Promise<void> {
    if (this.active || !Screen.supported()) return;
    installInputFilter(direction => this.scrollBy(direction * WHEEL_ROWS));
    const measured = await this.measure();
    if (measured && measured.rows >= 12) this.size = measured;
    this.active = true;
    this.rawWrite(`\x1b[?1049h\x1b[H\x1b[2J${this.mouseSeq(this.mouse)}`);
    const self = this;
    // Output goes into the conversation, and the frame is redrawn from it.
    this.out.write = function (chunk: unknown, ...rest: unknown[]): boolean {
      if (!self.active) return (self.rawWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      self.transcript.write(text);
      self.render();
      const cb = rest.find(r => typeof r === 'function') as (() => void) | undefined;
      if (cb) process.nextTick(cb);
      return true;
    } as typeof process.stdout.write;
    this.out.on('resize', this.onResize);
    process.once('exit', () => this.disable());
    this.render();
  }

  // Back to the normal screen, with the conversation printed into its history.
  disable(): void {
    if (!this.active) return;
    this.active = false;
    this.out.write = this.rawWrite as typeof process.stdout.write;
    this.out.off('resize', this.onResize);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    const text = this.transcript.text();
    this.rawWrite(`${this.mouseSeq(false)}\x1b[?2004l\x1b[?25h\x1b[?1049l${text ? `${text}\n` : ''}`);
  }

  get enabled(): boolean { return this.active; }

  private mouseSeq(on: boolean): string {
    // 1000 = button and wheel presses, 1006 = the SGR encoding of them.
    return on ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l';
  }

  // Mouse capture on or off (/mouse). Off gives drag-to-select back.
  setMouse(on: boolean): void {
    this.mouse = on;
    if (this.active) this.rawWrite(this.mouseSeq(on));
  }

  get mouseEnabled(): boolean { return this.mouse; }

  // Wipe the conversation (for /clear and ctrl+l).
  clearTranscript(): void {
    if (!this.active) { console.clear(); return; }
    this.transcript.clear();
    this.scroll = 0;
    this.lastTotal = 0;
    this.redraw();
  }

  setStatus(left: string, right: string[] = []): void {
    this.statusLeft = left;
    this.statusRight = right;
    this.render();
  }

  // The loading line; the spinner calls this every frame.
  setActivity(line: string): void {
    this.activity = line;
    this.render();
  }

  // Positive moves toward the newest output, negative back through history.
  scrollBy(rows: number): void {
    this.scroll = Math.max(0, this.scroll - rows);
    this.render();
  }

  scrollToBottom(): void {
    if (this.scroll === 0) return;
    this.scroll = 0;
    this.render();
  }

  // Forget what is on screen and draw every row again.
  redraw(): void {
    if (!this.active) return;
    this.frame = [];
    this.rawWrite('\x1b[H\x1b[2J');
    this.render();
  }

  // ── the frame ──────────────────────────────────────────────────────────────

  render(): void {
    if (!this.active) return;
    const rows = this.rows;
    const cols = this.cols;
    const area = this.area(cols);
    const viewH = Math.max(1, rows - area.rows.length);
    this.viewHeight = viewH;

    const content = this.transcript.rows(cols);
    const total = content.length;
    // Reading back through the conversation while output arrives: hold the
    // view still rather than letting new rows push it along.
    if (this.scroll > 0 && total > this.lastTotal) this.scroll += total - this.lastTotal;
    this.lastTotal = total;
    this.scroll = Math.max(0, Math.min(this.scroll, total - viewH));
    const start = Math.max(0, total - viewH - this.scroll);
    const view = content.slice(start, start + viewH);

    if (this.scroll > 0) {
      const note = ` ↓ ${this.scroll} more line${this.scroll === 1 ? '' : 's'} · scroll down or PgDn `;
      area.rows[1] = `\x1b[90m${'─'.repeat(2)}\x1b[39m\x1b[33m${note}\x1b[39m\x1b[90m${'─'.repeat(Math.max(0, cols - 3 - note.length))}\x1b[39m`;
    }

    const next: string[] = [];
    for (let i = 0; i < viewH; i++) next.push(view[i] ?? '');
    next.push(...area.rows);

    let s = '\x1b[?25l';
    for (let i = 0; i < next.length; i++) {
      if (next[i] !== this.frame[i]) s += `\x1b[${i + 1};1H\x1b[2K${next[i]}\x1b[0m`;
    }
    this.frame = next;
    if (this.editing) s += `\x1b[${viewH + area.cursorRow + 1};${area.cursorCol + 1}H\x1b[?25h`;
    this.rawWrite(s);
  }

  // The input wrapped into screen rows, with the cursor's row and column.
  private layoutInput(): { lines: string[]; cursorRow: number; cursorCol: number } {
    const promptWidth = stripAnsi(this.prompt).length;
    const avail = Math.max(10, this.cols - promptWidth - 1);
    const shown = this.secret ? '•'.repeat([...segmenter.segment(this.text)].length) : this.text;
    const cursorAt = this.secret ? [...segmenter.segment(this.text.slice(0, this.cursor))].length : this.cursor;
    const lines: string[] = [''];
    let width = 0, row = 0, cursorRow = 0, cursorCol = 0, offset = 0;
    for (const { segment } of segmenter.segment(shown)) {
      if (offset === cursorAt) { cursorRow = row; cursorCol = width; }
      if (segment === '\n' || segment === '\r\n') {
        lines.push(''); row++; width = 0;
      } else {
        const w = graphemeWidth(segment);
        if (width + w > avail) { lines.push(''); row++; width = 0; }
        lines[row] += segment;
        width += w;
      }
      offset += segment.length;
    }
    if (offset === cursorAt) {
      // At the very end of a full row the cursor belongs on the next one.
      if (width >= avail) { lines.push(''); row++; width = 0; }
      cursorRow = row; cursorCol = width;
    }
    return { lines, cursorRow, cursorCol: cursorCol + promptWidth };
  }

  // Taller than this, the input scrolls inside the box.
  private maxInputRows(): number {
    return Math.max(1, Math.min(12, Math.floor(this.rows / 2) - 4));
  }

  // One row, never wider than the screen.
  private fit(line: string, width = this.cols - 1): string {
    if (!line) return '';
    const plain = stripAnsi(line);
    return plain.length <= width ? line : plain.slice(0, Math.max(0, width - 1)) + '…';
  }

  // The fixed rows at the bottom, and where the cursor goes among them.
  private area(cols: number): { rows: string[]; cursorRow: number; cursorCol: number } {
    const { lines, cursorRow, cursorCol } = this.layoutInput();
    const boxRows = Math.min(lines.length, this.maxInputRows());
    // Which wrapped rows are visible when the input is taller than the box.
    const first = Math.max(0, Math.min(cursorRow - boxRows + 1, lines.length - boxRows));
    const rule = `\x1b[90m${'─'.repeat(cols - 1)}\x1b[39m`;
    const promptWidth = stripAnsi(this.prompt).length;

    const rows: string[] = [this.fit(this.activity), rule];
    for (let i = 0; i < boxRows; i++) {
      const idx = first + i;
      const lead = idx === 0 ? (this.editing ? this.prompt : `\x1b[90m${stripAnsi(this.prompt)}\x1b[39m`) : ' '.repeat(promptWidth);
      const body = idx === 0 && !this.text && this.placeholder ? `\x1b[90m${this.placeholder}\x1b[39m` : lines[idx] ?? '';
      rows.push(this.fit(lead + body));
    }
    rows.push(rule);
    rows.push(this.statusRow(cols));
    return { rows, cursorRow: 2 + (cursorRow - first), cursorCol };
  }

  private statusRow(cols: number): string {
    const leftLen = stripAnsi(this.statusLeft).length;
    const sep = '\x1b[90m  ·  \x1b[39m';
    const parts = this.statusRight.filter(Boolean);
    while (parts.length > 0 && cols - 3 - leftLen - stripAnsi(parts.join(sep)).length < 2) parts.pop();
    const right = parts.join(sep);
    const rightLen = stripAnsi(right).length;
    // Indented under the prompt, with the right side ending a column short of
    // the edge; when both do not fit, the right side is what gives way.
    const gap = cols - 3 - leftLen - rightLen;
    return gap >= 2
      ? `  ${this.statusLeft}${' '.repeat(gap)}${right}`
      : this.fit(`  ${this.statusLeft}`);
  }

  // ── the line editor ────────────────────────────────────────────────────────

  ask(prompt: string, opts: { history?: boolean; multiline?: boolean; secret?: boolean; placeholder?: string } = {}): Promise<AskResult> {
    if (!this.active) throw new Error('screen is not enabled');
    const useHistory = opts.history !== false;
    const multiline = opts.multiline !== false;
    return new Promise(resolve => {
      const stdin = process.stdin;
      const keys = keyStream();
      readline.emitKeypressEvents(keys);
      stdin.setRawMode(true);
      stdin.resume();
      // A size that changed without a resize event (or was wrong from the
      // start) is caught here, at worst one prompt late. Only once raw mode is
      // on: measure() restores whatever mode it found, and finding cooked mode
      // here would switch echo back on under the input box.
      void this.measure().then(m => {
        if (m && this.active && (m.rows !== this.rows || m.cols !== this.cols)) { this.size = m; this.redraw(); }
      });
      this.rawWrite('\x1b[?2004h'); // bracketed paste: a paste arrives fenced, newlines and all

      this.prompt = prompt;
      this.text = '';
      this.cursor = 0;
      this.secret = !!opts.secret;
      this.placeholder = opts.placeholder ?? '';
      this.editing = true;
      let histIdx = -1;
      let draft = '';
      let pasting = false;
      this.render();

      const finish = (result: AskResult) => {
        keys.off('keypress', onKey);
        this.rawWrite('\x1b[?2004l');
        stdin.setRawMode(false);
        stdin.pause();
        if (result.kind === 'line' && useHistory && result.text.trim()) {
          this.history = [result.text, ...this.history.filter(h => h !== result.text)].slice(0, HISTORY_SIZE);
          saveHistory(this.history);
        }
        // Sending a message returns the view to the newest output.
        if (result.kind === 'line') this.scroll = 0;
        this.editing = false;
        this.text = '';
        this.cursor = 0;
        this.secret = false;
        this.placeholder = '';
        this.render();
        resolve(result);
      };

      const insert = (s: string) => {
        this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
        this.cursor += s.length;
      };
      const bounds = () => boundaries(this.text);
      const prevBoundary = () => { const b = bounds(); let p = 0; for (const x of b) if (x < this.cursor) p = x; return p; };
      const nextBoundary = () => bounds().find(x => x > this.cursor) ?? this.text.length;
      const lineStart = () => this.text.lastIndexOf('\n', this.cursor - 1) + 1;
      const lineEnd = () => { const i = this.text.indexOf('\n', this.cursor); return i < 0 ? this.text.length : i; };
      const wordLeft = () => { let i = this.cursor; while (i > 0 && /\s/.test(this.text[i - 1])) i--; while (i > 0 && !/\s/.test(this.text[i - 1])) i--; return i; };
      const wordRight = () => { let i = this.cursor; while (i < this.text.length && /\s/.test(this.text[i])) i++; while (i < this.text.length && !/\s/.test(this.text[i])) i++; return i; };
      const recall = (idx: number) => {
        if (idx === -1) this.text = draft;
        else this.text = this.history[idx];
        histIdx = idx;
        this.cursor = this.text.length;
      };

      let inReport = false;
      const onKey = (str: string | undefined, key: Keypress | undefined) => {
        // A cursor position report (measure()) is decoded as keys too, and it
        // is not typing. Node's decoder reads at most two digits per number, so
        // "ESC[30;100R" arrives as "ESC[30;10" then "0" then "R": the truncated
        // head starts a swallow that ends at the R.
        if (key?.sequence && /^\x1b\[\d+;\d+R?$/.test(key.sequence)) { inReport = !key.sequence.endsWith('R'); return; }
        if (inReport) {
          if (str && /^\d$/.test(str)) return;
          inReport = false;
          if (str === 'R') return;
        }
        const name = key?.name;
        if (name === 'paste-start') { pasting = true; return; }
        if (name === 'paste-end') { pasting = false; this.render(); return; }
        if (pasting) {
          if (name === 'return' || name === 'enter') insert('\n');
          else if (str && !key?.ctrl) insert(str.replace(/\r\n?/g, '\n'));
          return; // rendered once, at paste-end
        }

        if (key?.ctrl && name === 'c') {
          if (this.text) { this.text = ''; this.cursor = 0; histIdx = -1; this.render(); return; }
          return finish({ kind: 'interrupt' });
        }
        if (key?.ctrl && name === 'd') {
          if (!this.text) return finish({ kind: 'eof' });
          if (this.cursor < this.text.length) this.text = this.text.slice(0, this.cursor) + this.text.slice(nextBoundary());
        } else if (name === 'return' && !key?.meta) {
          // A trailing backslash continues the message on a new line.
          if (multiline && this.text.slice(0, this.cursor).endsWith('\\')) {
            this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
            this.cursor -= 1;
            insert('\n');
          } else {
            return finish({ kind: 'line', text: this.text });
          }
        } else if ((name === 'enter' || (name === 'return' && key?.meta)) && multiline) {
          insert('\n'); // ctrl+j or alt+enter
        } else if (name === 'backspace') {
          if (key?.meta || key?.ctrl) { const w = wordLeft(); this.text = this.text.slice(0, w) + this.text.slice(this.cursor); this.cursor = w; }
          else if (this.cursor > 0) { const p = prevBoundary(); this.text = this.text.slice(0, p) + this.text.slice(this.cursor); this.cursor = p; }
        } else if (name === 'delete') {
          if (this.cursor < this.text.length) this.text = this.text.slice(0, this.cursor) + this.text.slice(nextBoundary());
        } else if (name === 'left' || (key?.ctrl && name === 'b')) {
          this.cursor = key?.meta ? wordLeft() : prevBoundary();
        } else if (name === 'right' || (key?.ctrl && name === 'f')) {
          this.cursor = key?.meta ? wordRight() : nextBoundary();
        } else if (key?.meta && name === 'b') {
          this.cursor = wordLeft();
        } else if (key?.meta && name === 'f') {
          this.cursor = wordRight();
        } else if (name === 'home' || (key?.ctrl && name === 'a')) {
          this.cursor = lineStart();
        } else if (name === 'end' || (key?.ctrl && name === 'e')) {
          this.cursor = lineEnd();
        } else if (key?.ctrl && name === 'u') {
          const s = lineStart(); this.text = this.text.slice(0, s) + this.text.slice(this.cursor); this.cursor = s;
        } else if (key?.ctrl && name === 'k') {
          this.text = this.text.slice(0, this.cursor) + this.text.slice(lineEnd());
        } else if (key?.ctrl && name === 'w') {
          const w = wordLeft(); this.text = this.text.slice(0, w) + this.text.slice(this.cursor); this.cursor = w;
        } else if (key?.ctrl && name === 'l') {
          this.clearTranscript();
        } else if (name === 'pageup' || name === 'pagedown') {
          this.scrollBy((name === 'pageup' ? -1 : 1) * Math.max(1, this.viewHeight - 2));
          return;
        } else if ((name === 'up' || name === 'down') && key?.shift) {
          this.scrollBy(name === 'up' ? -1 : 1);
          return;
        } else if (name === 'up') {
          const ls = lineStart();
          if (ls > 0) {
            // Move up a line inside a multi-line message.
            const col = this.cursor - ls;
            const prevStart = this.text.lastIndexOf('\n', ls - 2) + 1;
            this.cursor = Math.min(prevStart + col, ls - 1);
          } else if (useHistory && histIdx + 1 < this.history.length) {
            if (histIdx === -1) draft = this.text;
            recall(histIdx + 1);
          }
        } else if (name === 'down') {
          const le = lineEnd();
          if (le < this.text.length) {
            const col = this.cursor - lineStart();
            const nextEnd = this.text.indexOf('\n', le + 1);
            this.cursor = Math.min(le + 1 + col, nextEnd < 0 ? this.text.length : nextEnd);
          } else if (useHistory && histIdx >= 0) {
            recall(histIdx - 1);
          }
        } else if (name === 'tab' && key?.shift) {
          this.onShiftTab?.();
        } else if (name === 'tab') {
          if (this.text.startsWith('/') && !/\s/.test(this.text)) {
            const matches = this.completions.filter(cmd => cmd.startsWith(this.text));
            if (matches.length === 1) { this.text = `${matches[0]} `; this.cursor = this.text.length; }
            else if (matches.length > 1) {
              let common = matches[0];
              for (const m of matches) while (!m.startsWith(common)) common = common.slice(0, -1);
              this.text = common; this.cursor = common.length;
              this.placeholder = '';
            }
          }
        } else if (name === 'escape') {
          // Nothing to interrupt at the prompt; Esc clears what was typed.
          if (this.text) { this.text = ''; this.cursor = 0; }
        } else if (str && !key?.ctrl && !key?.meta && str >= ' ') {
          insert(str);
        } else {
          return;
        }
        this.render();
      };
      keys.on('keypress', onKey);
    });
  }
}
