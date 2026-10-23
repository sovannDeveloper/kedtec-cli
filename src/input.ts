import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { PassThrough } from 'stream';
import { StringDecoder } from 'string_decoder';
import { HOME_DIR } from './config';
import { ImageAttachment } from './images';
import type { Question, QuestionAnswers } from './tools';
import { c, clip, columns, stripAnsi } from './ui';

// Terminal input. A readline interface exists only while a question is being
// asked and is closed between them, so that while a turn runs the terminal is
// ours: TurnKeys reads raw keys then, which is what lets Esc or ctrl+c
// interrupt the agent instead of being echoed into the middle of its output.

// ── the input filter ─────────────────────────────────────────────────────────
//
// In the full-screen view the terminal reports mouse-wheel events on stdin,
// and a size check (screen.ts measure()) gets its answer there too. Both are
// taken out here, before any key decoder sees them — Node's decoder would
// split them into keys that look like typing — and everything else is passed
// on through keyStream(). Without the filter installed, keyStream() is stdin.

let filtered: PassThrough | null = null;
let reportsExpected = 0;

export function installInputFilter(onWheel: (direction: -1 | 1) => void): void {
  if (filtered) return;
  const out = new PassThrough();
  filtered = out;
  let pending = '';
  // A long paste comes in over several reads, and a character can be split
  // between two of them; the decoder holds its first bytes until the rest come.
  const decoder = new StringDecoder('utf8');
  process.stdin.on('data', (d: Buffer) => {
    let s = pending + decoder.write(d);
    pending = '';
    // A report split across two reads: hold its head until the rest arrives.
    // Only a report's own prefix is held — never a lone Esc, which is a key.
    const head = reportsExpected > 0 ? /\x1b\[(<[\d;]*|\d+;?\d*)$/ : /\x1b\[<[\d;]*$/;
    const cut = s.search(head);
    if (cut >= 0) { pending = s.slice(cut); s = s.slice(0, cut); }
    s = s.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (_m, button: string) => {
      const b = Number(button) & ~(4 | 8 | 16); // ignore shift/alt/ctrl bits
      if (b === 64) onWheel(-1);
      else if (b === 65) onWheel(1);
      return '';
    });
    if (reportsExpected > 0) {
      s = s.replace(/\x1b\[\d+;\d+R/g, () => { reportsExpected = Math.max(0, reportsExpected - 1); return ''; });
    }
    if (s) out.write(s);
  });
}

export function keyStream(): NodeJS.ReadableStream {
  return filtered ?? process.stdin;
}

// A cursor position report is on its way; the filter swallows it.
export function expectReport(): void {
  reportsExpected++;
  setTimeout(() => { reportsExpected = Math.max(0, reportsExpected - 1); }, 1000).unref();
}

// `images` are the ones pasted into the line (screen.ts), by the number in
// their "[Image #n]" placeholder; only those whose placeholder is still there.
export type AskResult = { kind: 'line'; text: string; images?: Map<number, ImageAttachment> } | { kind: 'interrupt' } | { kind: 'eof' };

const HISTORY_FILE = path.join(HOME_DIR, 'history');
export const HISTORY_SIZE = 500;

// Newest first. Shared by LineInput and the pinned input box in screen.ts.
export function loadHistory(): string[] {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).reverse().slice(0, HISTORY_SIZE);
  } catch {
    return [];
  }
}

export function saveHistory(history: string[]): void {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    // One entry per line, so multi-line prompts are kept as their first line only.
    const lines = history.slice(0, HISTORY_SIZE).map(h => h.split('\n')[0]).reverse();
    fs.writeFileSync(HISTORY_FILE, lines.join('\n') + '\n', { mode: 0o600 });
  } catch { /* history is a convenience */ }
}

// Anything that can ask the person a question: LineInput below, or the input
// box pinned to the bottom of the screen (screen.ts).
export interface Prompter {
  ask(prompt: string, opts?: { history?: boolean; multiline?: boolean; secret?: boolean; placeholder?: string }): Promise<AskResult>;
}

export class LineInput implements Prompter {
  private history: string[] = loadHistory();

  private saveHistory(): void {
    saveHistory(this.history);
  }

  // One prompt. A line ending in "\" continues on the next line, and lines that
  // arrive together (a paste) are joined into one message rather than sent as
  // several.
  ask(prompt: string, opts: { history?: boolean; multiline?: boolean; secret?: boolean; placeholder?: string } = {}): Promise<AskResult> {
    const useHistory = opts.history !== false;
    const multiline = opts.multiline !== false;
    return new Promise(resolve => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        history: useHistory ? [...this.history] : [],
        historySize: useHistory ? HISTORY_SIZE : 0,
        removeHistoryDuplicates: true,
        prompt,
      });
      // A secret is echoed as one * per character once the prompt is on screen,
      // so a paste visibly landed without the key itself being shown.
      let muted = false;
      if (opts.secret) {
        const mask = (s: string) => s.replace(/[^\r\n]/gu, '*');
        const anyRl = rl as unknown as { _writeToOutput: (s: string) => void };
        anyRl._writeToOutput = (s: string) => {
          if (!muted) return void process.stdout.write(s);
          // A redraw (backspace, cursor keys) writes the prompt and the whole line together.
          const p = rl.getPrompt();
          process.stdout.write(s.startsWith(p) ? p + mask(s.slice(p.length)) : mask(s));
        };
      }
      if (useHistory) rl.on('history', (h: string[]) => { this.history = h; });

      const lines: string[] = [];
      let timer: NodeJS.Timeout | undefined;
      let done = false;
      const finish = (result: AskResult) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        rl.close();
        if (result.kind === 'line' && useHistory && result.text.trim()) {
          this.history = [result.text, ...this.history.filter(h => h !== result.text)].slice(0, HISTORY_SIZE);
          this.saveHistory();
        }
        resolve(result);
      };

      rl.on('line', line => {
        if (multiline && line.endsWith('\\')) {
          lines.push(line.slice(0, -1));
          rl.setPrompt(c.gray('… '));
          rl.prompt();
          return;
        }
        lines.push(line);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish({ kind: 'line', text: lines.join('\n') }), multiline ? 20 : 0);
      });
      rl.on('SIGINT', () => {
        // ctrl+c on a half-typed line clears it, like a shell.
        if ((rl as unknown as { line: string }).line || lines.length > 0) {
          lines.length = 0;
          (rl as unknown as { line: string; cursor: number }).line = '';
          process.stdout.write('\n');
          rl.setPrompt(prompt);
          rl.prompt();
          return;
        }
        process.stdout.write('\n');
        finish({ kind: 'interrupt' });
      });
      rl.on('close', () => finish({ kind: 'eof' }));
      rl.prompt();
      muted = !!opts.secret;
    });
  }
}

// An arrow-key menu. Resolves with the chosen index, or null for Esc / ctrl+c.
// A `title` is drawn above the options. A `transient` menu, title included, is
// erased once answered, so the caller can print the choice in its place.
export function select(
  options: string[],
  initial = 0,
  { numbered = true, indent = '  ', footer, title, transient = false }:
    { numbered?: boolean; indent?: string; footer?: string; title?: string; transient?: boolean } = {},
): Promise<number | null> {
  return new Promise(resolve => {
    const stdin = process.stdin;
    const keys = keyStream();
    readline.emitKeypressEvents(keys);
    const wasRaw = !!stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let idx = Math.max(0, Math.min(options.length - 1, initial));
    // A footer sits under the options and is redrawn with them: a blank line, then the text.
    const footerLines = footer ? 2 : 0;
    const render = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${options.length + footerLines}A`);
      options.forEach((opt, i) => {
        const label = numbered ? `${i + 1}. ${opt}` : opt;
        const line = i === idx ? `${c.accent('❯')} ${c.accent(label)}` : numbered ? `  ${c.gray(`${i + 1}.`)} ${opt}` : `  ${opt}`;
        process.stdout.write(`\x1b[2K${indent}${line}\n`);
      });
      if (footer) process.stdout.write(`\x1b[2K\n\x1b[2K${indent}${footer}\n`);
    };
    const titleLines = title ? title.split('\n').length : 0;
    const done = (value: number | null) => {
      keys.off('keypress', onKey);
      // Back to the title's first row, then erase from there to the end.
      if (transient) process.stdout.write(`\x1b[${titleLines + options.length + footerLines}A\r\x1b[J`);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(value);
    };
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
      if ((key?.ctrl && key.name === 'c') || key?.name === 'escape') return done(null);
      if (key?.name === 'up' || key?.name === 'k') idx = (idx - 1 + options.length) % options.length;
      else if (key?.name === 'down' || key?.name === 'j' || key?.name === 'tab') idx = (idx + 1) % options.length;
      else if (key?.name === 'return' || key?.name === 'enter') return done(idx);
      else if (str && /^[1-9]$/.test(str) && Number(str) <= options.length) return done(Number(str) - 1);
      else return;
      render(false);
    };
    keys.on('keypress', onKey);
    if (title) process.stdout.write(`${title}\n`);
    render(true);
  });
}

// The model's questions (ask_user) as one form, drawn in place and erased when
// it closes. Several questions get a tab each, and a Submit tab that reviews
// the answers:
//
//   ─────────────────────────────
//   ← ☐ Focus  ☐ Task type  ✔ Submit →
//
//   What do you want to work on today?
//
//   ❯ 1. KEDTec CLI
//        The terminal agent in this folder
//     2. Type something.
//   ─────────────────────────────
//     3. Chat about this
//
//   Enter to select · Tab/Arrow keys to navigate · Esc to cancel
//
// An option is picked with Enter or its number, and the form moves on to the
// next question; a single question is answered at once. On "Type something."
// typing writes an answer of one's own. "Chat about this" ends the form so the
// person can talk it over instead.
export function questionForm(questions: Question[]): Promise<QuestionAnswers> {
  return new Promise(resolve => {
    const stdin = process.stdin;
    const keys = keyStream();
    readline.emitKeypressEvents(keys);
    const wasRaw = !!stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    const multi = questions.length > 1;
    const submitTab = questions.length; // only when multi
    const answers: (string | undefined)[] = questions.map(() => undefined);
    const typed: string[] = questions.map(() => '');
    // The highlighted row of each tab; the Submit tab's is answers.length's.
    const rowOf: number[] = [...questions.map(() => 0), 0];
    let tab = 0;
    let drawn = 0;

    // Rows of a question: its options, "Type something.", "Chat about this".
    const typeRow = (q: number) => questions[q].options.length;
    const chatRow = (q: number) => questions[q].options.length + 1;
    const rowCount = (t: number) => (t === submitTab && multi ? 2 : questions[t].options.length + 2);

    const fitLine = (line: string, width: number) => {
      const plain = stripAnsi(line);
      return plain.length <= width ? line : `${plain.slice(0, Math.max(0, width - 1))}…`;
    };
    const tabBar = (width: number): string => {
      const label = (t: number) => (t === submitTab
        ? '✔ Submit'
        : `${answers[t] !== undefined ? '☒' : '☐'} ${questions[t].header ? clip(questions[t].header!, 12) : `Q${t + 1}`}`);
      const tabs = [...questions.keys(), submitTab];
      const plainWidth = 4 + tabs.reduce((n, t) => n + label(t).length + 3, 0);
      const name = (t: number) => (plainWidth > width && t !== submitTab ? `${answers[t] !== undefined ? '☒' : '☐'} ${t + 1}` : label(t));
      const body = tabs.map(t => (t === tab ? c.inverse(c.accent(` ${name(t)} `)) : ` ${t !== submitTab && answers[t] !== undefined ? c.green(name(t)) : name(t)} `)).join(' ');
      return `${c.gray('←')} ${body} ${c.gray('→')}`;
    };
    const row = (on: boolean, n: number, text: string) => `${on ? c.accent('❯') : ' '} ${on ? c.accent(`${n}.`) : c.gray(`${n}.`)} ${text}`;

    const lines = (width: number): string[] => {
      const out = [c.gray('─'.repeat(width))];
      if (multi) out.push(tabBar(width));
      out.push('');
      if (multi && tab === submitTab) {
        out.push(c.bold('Review your answers'), '');
        questions.forEach((q, i) => {
          out.push(` ${c.gray('●')} ${q.question}`);
          out.push(`   ${c.gray('→')} ${answers[i] !== undefined ? c.accent(answers[i]!) : c.yellow('not answered')}`);
        });
        if (answers.some(a => a === undefined)) out.push('', c.yellow('⚠ You have not answered all questions'));
        out.push('', 'Ready to submit your answers?', '');
        out.push(row(rowOf[tab] === 0, 1, rowOf[tab] === 0 ? c.accent('Submit answers') : 'Submit answers'));
        out.push(row(rowOf[tab] === 1, 2, rowOf[tab] === 1 ? c.accent('Cancel') : 'Cancel'));
      } else {
        const q = questions[tab];
        const at = rowOf[tab];
        out.push(c.bold(q.question), '');
        q.options.forEach((o, i) => {
          const chosen = answers[tab] === o.label ? ` ${c.green('✔')}` : '';
          out.push(row(at === i, i + 1, `${at === i ? c.accent(o.label) : o.label}${chosen}`));
          if (o.description) out.push(`     ${c.gray(o.description)}`);
        });
        const own = typed[tab];
        const cursor = at === typeRow(tab) ? c.inverse(' ') : '';
        const ownChosen = own && answers[tab] === own ? ` ${c.green('✔')}` : '';
        out.push(row(at === typeRow(tab), typeRow(tab) + 1, own ? `${own}${cursor}${ownChosen}` : `${cursor}${c.gray('Type something.')}`));
        out.push(c.gray('─'.repeat(width)));
        out.push(row(at === chatRow(tab), chatRow(tab) + 1, at === chatRow(tab) ? c.accent('Chat about this') : 'Chat about this'));
      }
      out.push('', c.gray(`Enter to select · ${multi ? 'Tab/Arrow keys' : 'Arrow keys'} to navigate · Esc to cancel`));
      return out.map(l => fitLine(l, width));
    };

    const erase = () => { if (drawn) process.stdout.write(`\x1b[${drawn}A\r\x1b[J`); drawn = 0; };
    const render = () => {
      const out = lines(columns() - 1);
      erase();
      process.stdout.write(out.map(l => `${l}\n`).join(''));
      drawn = out.length;
    };
    const done = (result: QuestionAnswers) => {
      keys.off('keypress', onKey);
      erase();
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(result);
    };
    const switchTab = (delta: number) => {
      if (!multi) return;
      tab = (tab + delta + questions.length + 1) % (questions.length + 1);
    };
    // After an answer: the next question still open, else the Submit tab.
    const answer = (value: string) => {
      answers[tab] = value;
      if (!multi) return done({ kind: 'answered', answers: [...answers] });
      const next = questions.findIndex((_, i) => i > tab && answers[i] === undefined);
      const earlier = answers.findIndex(a => a === undefined);
      tab = next >= 0 ? next : earlier >= 0 ? earlier : submitTab;
      rowOf[submitTab] = 0;
      render();
    };
    const choose = (r: number) => {
      if (multi && tab === submitTab) return r === 0 ? done({ kind: 'answered', answers: [...answers] }) : done({ kind: 'dismissed' });
      if (r === chatRow(tab)) return done({ kind: 'chat' });
      if (r === typeRow(tab)) return typed[tab].trim() ? answer(typed[tab].trim()) : render();
      answer(questions[tab].options[r].label);
    };

    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean } | undefined) => {
      const name = key?.name;
      if (name === 'escape' || (key?.ctrl && name === 'c')) return done({ kind: 'dismissed' });
      const typing = !(multi && tab === submitTab) && rowOf[tab] === typeRow(tab);
      const n = rowCount(tab);
      if (name === 'return' || name === 'enter') return choose(rowOf[tab]);
      if (name === 'up') rowOf[tab] = (rowOf[tab] - 1 + n) % n;
      else if (name === 'down') rowOf[tab] = (rowOf[tab] + 1) % n;
      else if (name === 'left' || (name === 'tab' && key?.shift)) switchTab(-1);
      else if (name === 'right' || name === 'tab') switchTab(1);
      else if (typing && name === 'backspace') typed[tab] = [...typed[tab]].slice(0, -1).join('');
      else if (typing && key?.ctrl && name === 'u') typed[tab] = '';
      else if (typing && str && !key?.ctrl && !key?.meta && str >= ' ') typed[tab] += str;
      else if (str && /^[1-9]$/.test(str) && Number(str) <= n) {
        rowOf[tab] = Number(str) - 1;
        // A number picks its row, except "Type something.", which it only moves to.
        if (multi && tab === submitTab) return choose(rowOf[tab]);
        if (rowOf[tab] !== typeRow(tab)) return choose(rowOf[tab]);
      } else return;
      render();
    };
    keys.on('keypress', onKey);
    render();
  });
}

export interface PanelTab {
  name: string;
  // The tab's lines for a body `width` columns wide. Lines must fit: a line the
  // terminal wraps throws off the redraw, which counts lines, not rows.
  body(width: number): string[];
}

// A dialog with tabs (/help), drawn in place like select() and erased when it
// closes: ←/→ or tab switch tabs, Esc, enter or q close it.
export function tabbedPanel(title: string, tabs: PanelTab[]): Promise<void> {
  return new Promise(resolve => {
    const stdin = process.stdin;
    const keys = keyStream();
    readline.emitKeypressEvents(keys);
    const wasRaw = !!stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let idx = 0;
    let drawn = 0;
    const erase = () => { if (drawn) process.stdout.write(`\x1b[${drawn}A\r\x1b[J`); drawn = 0; };
    const render = () => {
      const width = columns();
      const tabRow = tabs.map((t, i) => (i === idx ? c.inverse(c.bold(c.accent(` ${t.name} `))) : ` ${t.name} `)).join(' ');
      const lines = [
        c.accent('─'.repeat(width - 1)),
        '',
        `  ${c.bold(c.accent(title))}  ${tabRow}`,
        '',
        ...tabs[idx].body(width - 4).map(l => (l ? `  ${l}` : '')),
        '',
        `  ${c.gray(c.italic(`${tabs.length > 1 ? '←/→ to switch tabs · ' : ''}Esc to close`))}`,
      ];
      erase();
      process.stdout.write(lines.map(l => `${l}\n`).join(''));
      drawn = lines.length;
    };
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean } | undefined) => {
      const name = key?.name;
      if (name === 'escape' || name === 'return' || name === 'enter' || str === 'q' || (key?.ctrl && name === 'c')) {
        keys.off('keypress', onKey);
        erase();
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        stdin.pause();
        return resolve();
      }
      if (name === 'left' || (name === 'tab' && key?.shift)) idx = (idx - 1 + tabs.length) % tabs.length;
      else if (name === 'right' || name === 'tab') idx = (idx + 1) % tabs.length;
      else return;
      render();
    };
    keys.on('keypress', onKey);
    render();
  });
}

// While a turn runs: swallow typing, turn Esc or ctrl+c into an interrupt, and
// pass on the few keys that still mean something (shift+tab, page up/down).
export class TurnKeys {
  private active = false;
  private readonly onData = (buf: Buffer | string) => {
    const s = buf.toString();
    if (s === '\x03' || s === '\x1b') this.onInterrupt();
    else if (s === '\x1b[Z') this.onShiftTab?.();
    else if (s === '\x1b[5~') this.onPage?.(-1);
    else if (s === '\x1b[6~') this.onPage?.(1);
  };

  constructor(
    private readonly onInterrupt: () => void,
    private readonly onShiftTab?: () => void,
    private readonly onPage?: (direction: -1 | 1) => void,
  ) {}

  start(): void {
    if (!process.stdin.isTTY || this.active) return;
    this.active = true;
    process.stdin.setRawMode(true);
    keyStream().on('data', this.onData);
    process.stdin.resume();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    keyStream().off('data', this.onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  // For a permission prompt in the middle of a turn, which needs the keys itself.
  async suspend<T>(fn: () => Promise<T>): Promise<T> {
    const was = this.active;
    this.stop();
    try { return await fn(); } finally { if (was) this.start(); }
  }
}
