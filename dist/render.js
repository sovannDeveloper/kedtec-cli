"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalRenderer = void 0;
const ui_1 = require("./ui");
// What the spinner calls the model's work, picked once per turn.
const VERBS = ['Thinking', 'Pondering', 'Brewing', 'Cooking', 'Crunching', 'Mulling', 'Noodling', 'Percolating', 'Tinkering', 'Working'];
// …and how the line after a finished turn reports it.
const DONE_VERBS = ['Worked', 'Baked', 'Brewed', 'Cooked', 'Crunched', 'Churned', 'Sautéed', 'Simmered'];
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
// Draws agent events on a terminal stream: stdout in the REPL, stderr in
// print mode (where stdout is reserved for the final answer).
//
// The spinner either redraws the current line (and so must be cleared before
// anything else is printed), or — given an activity sink — lives in a pinned
// row of its own above the input box, where it keeps running while the answer
// streams in above it.
class TerminalRenderer {
    stream;
    opts;
    spinner;
    md = null;
    reasoningShown = false;
    verb = 'Thinking';
    outputChars = 0;
    constructor(stream, opts) {
        this.stream = stream;
        this.opts = opts;
        this.spinner = new ui_1.Spinner(stream, opts.activity);
    }
    write(s) { this.stream.write(s); }
    // Make way for output: only an inline spinner has to get out of the way.
    pause() {
        if (!this.spinner.pinned)
            this.spinner.stop();
    }
    spin(label) {
        if (!this.opts.spinner)
            return;
        if (this.spinner.running)
            this.spinner.update(label);
        else
            this.spinner.start(label);
    }
    // A turn's clock and token count run from the message being sent to the answer.
    beginTurn() {
        this.verb = pick(VERBS);
        this.outputChars = 0;
        this.spinner.since = Date.now();
        this.spinner.tokens = 0;
    }
    // Stops the spinner and returns the line that reports the finished turn.
    endTurn() {
        const ms = Date.now() - (this.spinner.since || Date.now());
        this.spinner.stop();
        this.spinner.since = 0;
        return `${ui_1.c.accent('✻')} ${ui_1.c.gray(`${pick(DONE_VERBS)} for ${(0, ui_1.formatDuration)(ms)}`)}`;
    }
    countOutput(delta) {
        this.outputChars += delta.length;
        this.spinner.tokens = Math.round(this.outputChars / 4);
    }
    thinking() { this.spin(`${this.verb}…`); }
    text(delta) {
        this.countOutput(delta);
        if (!this.opts.showText)
            return;
        this.pause();
        this.endReasoning();
        if (!this.md) {
            this.write('\n');
            this.md = new ui_1.MarkdownStream(s => {
                this.pause();
                this.write(s);
            });
        }
        this.md.write(delta);
    }
    reasoning(delta) {
        this.countOutput(delta);
        if (!this.opts.showReasoning) {
            this.spin(`${this.verb}…`);
            return;
        }
        this.pause();
        if (!this.reasoningShown) {
            this.write(`\n${ui_1.c.gray('∴ Thinking')}\n`);
            this.reasoningShown = true;
        }
        this.write(ui_1.c.gray(ui_1.c.italic(delta)));
    }
    endReasoning() {
        if (this.reasoningShown) {
            this.write('\n');
            this.reasoningShown = false;
        }
    }
    toolCallStreaming(label) { this.spin(`${label === 'Bash' ? 'Preparing command' : `Preparing ${label.toLowerCase()}`}…`); }
    assistantEnd() {
        this.pause();
        this.endReasoning();
        this.md?.end();
        this.md = null;
        this.opts.onRoundEnd?.();
    }
    toolStart(label, summary) {
        this.pause();
        this.write(`\n${(0, ui_1.toolHeader)(label, summary)}\n`);
        this.spin(`${label === 'Bash' ? 'Running' : label}…`);
    }
    toolEnd(outcome) {
        this.pause();
        const display = (outcome.display ?? (outcome.isError ? outcome.content : '')).trim();
        if (!display)
            return;
        const lines = display.split('\n').slice(0, 12);
        lines.forEach((line, i) => {
            if (i === 0)
                this.write((0, ui_1.toolResultLine)(outcome.isError ? (0, ui_1.clip)(line, 300) : line, outcome.isError) + '\n');
            else
                this.write(`     ${outcome.isError ? ui_1.c.red(line) : line.includes('\x1b[') ? line : ui_1.c.gray(line)}\n`);
        });
        this.spin(`${this.verb}…`);
    }
    status(label) { this.spin(label); }
    sources(sources, research) {
        if (!this.opts.showText)
            return;
        this.pause();
        const rows = [];
        for (const s of sources.slice(0, 8)) {
            const where = [s.source, s.section].filter(Boolean).join(' · ');
            if (where)
                rows.push(`${s.n !== undefined ? `[${s.n}] ` : ''}${where}`);
        }
        for (const p of research.slice(0, 8))
            if (p.url)
                rows.push(`${p.title ? `${(0, ui_1.clip)(p.title, 60)} — ` : ''}${p.url}`);
        if (rows.length === 0)
            return;
        this.write(`  ${ui_1.c.gray('Sources:')}\n${rows.map(r => `    ${ui_1.c.gray(r)}`).join('\n')}\n`);
    }
    notice(message) {
        this.pause();
        this.write(`\n${ui_1.c.yellow('!')} ${message}\n`);
    }
}
exports.TerminalRenderer = TerminalRenderer;
//# sourceMappingURL=render.js.map