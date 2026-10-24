// Terminal output: colours, the spinner, a line-buffered Markdown renderer and
// diff colouring. No dependency — a CLI that pulls in a colour library, a
// spinner library and a Markdown library to print text is three supply-chain
// risks for sixty lines of ANSI.

const useColor = (stream: NodeJS.WriteStream) => !!stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

let colorOn = useColor(process.stdout);
export function setColor(on: boolean): void { colorOn = on; }

const wrap = (open: string, close = '\x1b[0m') => (s: string) => (colorOn ? `\x1b[${open}m${s}${close}` : s);

export const c = {
  bold: wrap('1', '\x1b[22m'),
  dim: wrap('2', '\x1b[22m'),
  italic: wrap('3', '\x1b[23m'),
  red: wrap('31', '\x1b[39m'),
  green: wrap('32', '\x1b[39m'),
  yellow: wrap('33', '\x1b[39m'),
  blue: wrap('34', '\x1b[39m'),
  magenta: wrap('35', '\x1b[39m'),
  cyan: wrap('36', '\x1b[39m'),
  gray: wrap('90', '\x1b[39m'),
  inverse: wrap('7', '\x1b[27m'),
  // KEDTec teal.
  accent: wrap('38;5;30', '\x1b[39m'),
};

// The KEDTec mark, its SVG rasterised to braille (2×4 dots a cell) in its own
// teal, #00B4B4. Empty without colour: the dots alone read as noise.
const LOGO = [
  '⠀⠀⣠⣶⠟⢛⢩⣥⣂⡀⠀⠀',
  '⢠⣾⠟⠀⠀⠀⠀⠀⠈⠻⣦⡀',
  '⣿⣿⠀⢸⡿⣀⣼⠋⠀⠀⢸⣷',
  '⣿⣿⠀⢸⣿⠉⢻⣦⡀⠀⣸⡿',
  '⠘⢿⣦⠀⠀⠀⠀⠀⢀⣴⠟⠁',
  '⠀⠀⠙⠿⣦⣬⣙⡛⠍⠁⠀⠀',
];
export function logo(): string[] {
  return colorOn ? LOGO.map(l => `\x1b[38;2;0;180;180m${l}\x1b[39m`) : [];
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[mK]/g, '');
}

// A line of a message the user sent, as a bar across the terminal: "erase to
// end of line" paints the rest of the row in the background colour.
export function userBar(s: string): string {
  return colorOn ? `\x1b[48;5;237m${s} \x1b[K\x1b[49m` : s;
}

// The terminal's title — what VS Code shows on the terminal tab instead of
// "node". OSC 0 sets it; an empty one hands the tab back to the process name.
export const TERMINAL_TITLE = '✳ KEDTec';

export function setTerminalTitle(title: string): void {
  if (!process.stdout.isTTY || process.env.TERM === 'dumb') return;
  process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`);
}

export function columns(): number {
  return Math.max(40, process.stdout.columns || 100);
}

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

// Plain text broken into lines of at most `width` columns, at spaces.
export function wrapText(text: string, width: number): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

// Groups of short lines laid side by side, as many groups to a row as fit in
// `width`, each column as wide as its longest line. A group is never split, so
// on a narrow terminal the columns fold under each other instead of wrapping.
export function columnLayout(groups: string[][], width: number, gap = 4): string[] {
  const len = (s: string) => stripAnsi(s).length;
  for (let k = groups.length; k >= 1; k--) {
    const colWidths = Array.from({ length: k }, (_, i) =>
      Math.max(0, ...groups.filter((_g, j) => j % k === i).flat().map(len)));
    if (k > 1 && colWidths.reduce((a, b) => a + b, 0) + gap * (k - 1) > width) continue;
    const out: string[] = [];
    for (let start = 0; start < groups.length; start += k) {
      const row = groups.slice(start, start + k);
      const height = Math.max(...row.map(g => g.length));
      for (let i = 0; i < height; i++) {
        const cells = row.map((g, j) => (j === row.length - 1 ? g[i] ?? '' : (g[i] ?? '') + ' '.repeat(colWidths[j] + gap - len(g[i] ?? ''))));
        out.push(cells.join('').trimEnd());
      }
    }
    return out;
  }
  return [];
}

// ── spinner ──────────────────────────────────────────────────────────────────

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

// Where a pinned spinner draws: one line of text, or '' to clear it. Without
// one the spinner redraws the current terminal line in place, which is what
// print mode and the plain-prompt fallback use.
export type ActivitySink = (line: string) => void;

export function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  return `${m}m ${secs % 60}s`;
}

export function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private label = '';
  private readonly enabled: boolean;
  // When the work being timed began — the whole turn, not this spinner run,
  // so the clock does not restart after every tool call.
  since = 0;
  // Output tokens received so far this turn (estimated), shown as "↓ 1.2k".
  tokens = 0;

  constructor(private readonly stream: NodeJS.WriteStream = process.stderr, private readonly sink?: ActivitySink) {
    this.enabled = !!stream.isTTY;
  }

  get pinned(): boolean { return !!this.sink; }

  start(label: string): void {
    this.label = label;
    if (!this.enabled) return;
    if (this.timer) return;
    if (!this.since) this.since = Date.now();
    this.timer = setInterval(() => this.draw(), 120);
    this.draw();
  }

  update(label: string): void { this.label = label; }

  get running(): boolean { return !!this.timer; }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.sink) this.sink('');
    else this.stream.write('\r\x1b[2K');
  }

  private draw(): void {
    const glyph = c.accent(FRAMES[this.frame++ % FRAMES.length]);
    const parts = [formatDuration(Date.now() - this.since)];
    if (this.tokens > 0) parts.push(`↓ ${formatCount(this.tokens)} tokens`);
    parts.push('esc to interrupt');
    let text = `${glyph} ${c.accent(this.label)} ${c.gray(`(${parts.join(' · ')})`)}`;
    if (stripAnsi(text).length > columns() - 1) text = `${glyph} ${c.accent(this.label)}`;
    if (this.sink) this.sink(text);
    else this.stream.write(`\r\x1b[2K${text}`);
  }
}

// ── Markdown ─────────────────────────────────────────────────────────────────

function inline(s: string): string {
  if (!colorOn) return s;
  return s
    .replace(/`([^`\n]+)`/g, (_m, code) => c.cyan(code))
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, b) => c.bold(b))
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, (_m, pre, it) => `${pre}${c.italic(it)}`)
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, (_m, text, url) => `${text} ${c.gray(`(${url})`)}`);
}

// Renders the assistant's Markdown one complete line at a time, so a reply
// still appears while it streams but a `**bold**` split across two deltas is
// never printed half-styled.
export class MarkdownStream {
  private buf = '';
  private inFence = false;
  private first = true;

  constructor(private readonly out: (s: string) => void = s => process.stdout.write(s)) {}

  write(delta: string): void {
    this.buf += delta;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      this.emit(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
  }

  end(): void {
    if (this.buf) this.emit(this.buf);
    this.buf = '';
  }

  get started(): boolean { return !this.first; }

  private emit(line: string): void {
    // Leading blank lines before anything was said are noise.
    if (this.first && !line.trim()) return;
    const bullet = this.first ? `${c.accent('●')} ` : '  ';
    this.first = false;
    this.out(bullet + this.render(line) + '\n');
  }

  private render(line: string): string {
    const fence = /^\s*(```|~~~)/.test(line);
    if (fence) {
      this.inFence = !this.inFence;
      return c.gray(line);
    }
    if (this.inFence) return colorOn ? c.yellow(line) : line;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) return c.bold(inline(heading[2]));
    const bulletLine = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bulletLine) return `${bulletLine[1]}• ${inline(bulletLine[2])}`;
    if (/^\s*>\s?/.test(line)) return c.gray('│ ') + c.italic(inline(line.replace(/^\s*>\s?/, '')));
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) return c.gray('─'.repeat(Math.min(60, columns() - 4)));
    return inline(line);
  }
}

// ── diffs and tool rows ──────────────────────────────────────────────────────

export function colorDiff(diff: string, indent = '    '): string {
  return diff.split('\n').map(line => {
    if (line.startsWith('+')) return indent + c.green(line);
    if (line.startsWith('-')) return indent + c.red(line);
    if (line.startsWith('@@')) return indent + c.cyan(line);
    return indent + c.gray(line);
  }).join('\n');
}

export function toolHeader(name: string, summary: string): string {
  return `${c.green('●')} ${c.bold(name)}${summary ? c.gray(`(${summary})`) : ''}`;
}

export function toolResultLine(text: string, isError = false): string {
  const body = isError ? c.red(text) : c.gray(text);
  return `  ${c.gray('⎿')}  ${body}`;
}
