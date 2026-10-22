import { AgentEvents } from './agent';
import { KbSource, ResearchPage } from './client';
import { ToolOutcome } from './tools';
import { ActivitySink, MarkdownStream, Spinner, c, clip, formatDuration, toolHeader, toolResultLine } from './ui';

// What the spinner calls the model's work, picked once per turn.
const VERBS = ['Thinking', 'Pondering', 'Brewing', 'Cooking', 'Crunching', 'Mulling', 'Noodling', 'Percolating', 'Tinkering', 'Working'];
// …and how the line after a finished turn reports it.
const DONE_VERBS = ['Worked', 'Baked', 'Brewed', 'Cooked', 'Crunched', 'Churned', 'Sautéed', 'Simmered'];

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

// Draws agent events on a terminal stream: stdout in the REPL, stderr in
// print mode (where stdout is reserved for the final answer).
//
// The spinner either redraws the current line (and so must be cleared before
// anything else is printed), or — given an activity sink — lives in a pinned
// row of its own above the input box, where it keeps running while the answer
// streams in above it.
export class TerminalRenderer implements AgentEvents {
  readonly spinner: Spinner;
  private md: MarkdownStream | null = null;
  private reasoningShown = false;
  private verb = 'Thinking';
  private outputChars = 0;

  constructor(
    private readonly stream: NodeJS.WriteStream,
    private readonly opts: { showText: boolean; showReasoning: boolean; spinner: boolean; onRoundEnd?: () => void; activity?: ActivitySink },
  ) {
    this.spinner = new Spinner(stream, opts.activity);
  }

  private write(s: string): void { this.stream.write(s); }

  // Make way for output: only an inline spinner has to get out of the way.
  private pause(): void {
    if (!this.spinner.pinned) this.spinner.stop();
  }

  private spin(label: string): void {
    if (!this.opts.spinner) return;
    if (this.spinner.running) this.spinner.update(label);
    else this.spinner.start(label);
  }

  // A turn's clock and token count run from the message being sent to the answer.
  beginTurn(): void {
    this.verb = pick(VERBS);
    this.outputChars = 0;
    this.spinner.since = Date.now();
    this.spinner.tokens = 0;
  }

  // Stops the spinner and returns the line that reports the finished turn.
  endTurn(): string {
    const ms = Date.now() - (this.spinner.since || Date.now());
    this.spinner.stop();
    this.spinner.since = 0;
    return `${c.accent('✻')} ${c.gray(`${pick(DONE_VERBS)} for ${formatDuration(ms)}`)}`;
  }

  private countOutput(delta: string): void {
    this.outputChars += delta.length;
    this.spinner.tokens = Math.round(this.outputChars / 4);
  }

  thinking(): void { this.spin(`${this.verb}…`); }

  text(delta: string): void {
    this.countOutput(delta);
    if (!this.opts.showText) return;
    this.pause();
    this.endReasoning();
    if (!this.md) {
      this.write('\n');
      this.md = new MarkdownStream(s => {
        this.pause();
        this.write(s);
      });
    }
    this.md.write(delta);
  }

  reasoning(delta: string): void {
    this.countOutput(delta);
    if (!this.opts.showReasoning) { this.spin(`${this.verb}…`); return; }
    this.pause();
    if (!this.reasoningShown) { this.write(`\n${c.gray('∴ Thinking')}\n`); this.reasoningShown = true; }
    this.write(c.gray(c.italic(delta)));
  }

  private endReasoning(): void {
    if (this.reasoningShown) { this.write('\n'); this.reasoningShown = false; }
  }

  toolCallStreaming(label: string): void { this.spin(`${label === 'Bash' ? 'Preparing command' : `Preparing ${label.toLowerCase()}`}…`); }

  assistantEnd(): void {
    this.pause();
    this.endReasoning();
    this.md?.end();
    this.md = null;
    this.opts.onRoundEnd?.();
  }

  toolStart(label: string, summary: string): void {
    this.pause();
    this.write(`\n${toolHeader(label, summary)}\n`);
    this.spin(`${label === 'Bash' ? 'Running' : label}…`);
  }

  toolEnd(outcome: ToolOutcome): void {
    this.pause();
    const display = (outcome.display ?? (outcome.isError ? outcome.content : '')).trim();
    if (!display) return;
    const lines = display.split('\n').slice(0, 12);
    lines.forEach((line, i) => {
      if (i === 0) this.write(toolResultLine(outcome.isError ? clip(line, 300) : line, outcome.isError) + '\n');
      else this.write(`     ${outcome.isError ? c.red(line) : line.includes('\x1b[') ? line : c.gray(line)}\n`);
    });
    this.spin(`${this.verb}…`);
  }

  status(label: string): void { this.spin(label); }

  sources(sources: KbSource[], research: ResearchPage[]): void {
    if (!this.opts.showText) return;
    this.pause();
    const rows: string[] = [];
    for (const s of sources.slice(0, 8)) {
      const where = [s.source, s.section].filter(Boolean).join(' · ');
      if (where) rows.push(`${s.n !== undefined ? `[${s.n}] ` : ''}${where}`);
    }
    for (const p of research.slice(0, 8)) if (p.url) rows.push(`${p.title ? `${clip(p.title, 60)} — ` : ''}${p.url}`);
    if (rows.length === 0) return;
    this.write(`  ${c.gray('Sources:')}\n${rows.map(r => `    ${c.gray(r)}`).join('\n')}\n`);
  }

  notice(message: string): void {
    this.pause();
    this.write(`\n${c.yellow('!')} ${message}\n`);
  }
}
