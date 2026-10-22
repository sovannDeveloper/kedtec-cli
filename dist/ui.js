"use strict";
// Terminal output: colours, the spinner, a line-buffered Markdown renderer and
// diff colouring. No dependency — a CLI that pulls in a colour library, a
// spinner library and a Markdown library to print text is three supply-chain
// risks for sixty lines of ANSI.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarkdownStream = exports.Spinner = exports.TERMINAL_TITLE = exports.c = void 0;
exports.setColor = setColor;
exports.stripAnsi = stripAnsi;
exports.setTerminalTitle = setTerminalTitle;
exports.columns = columns;
exports.clip = clip;
exports.formatDuration = formatDuration;
exports.formatCount = formatCount;
exports.colorDiff = colorDiff;
exports.toolHeader = toolHeader;
exports.toolResultLine = toolResultLine;
const useColor = (stream) => !!stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
let colorOn = useColor(process.stdout);
function setColor(on) { colorOn = on; }
const wrap = (open, close = '\x1b[0m') => (s) => (colorOn ? `\x1b[${open}m${s}${close}` : s);
exports.c = {
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
    // KEDTec teal.
    accent: wrap('38;5;30', '\x1b[39m'),
};
function stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}
// The terminal's title — what VS Code shows on the terminal tab instead of
// "node". OSC 0 sets it; an empty one hands the tab back to the process name.
exports.TERMINAL_TITLE = '✳ KEDTec';
function setTerminalTitle(title) {
    if (!process.stdout.isTTY || process.env.TERM === 'dumb')
        return;
    process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`);
}
function columns() {
    return Math.max(40, process.stdout.columns || 100);
}
function clip(s, n) {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
// ── spinner ──────────────────────────────────────────────────────────────────
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
function formatDuration(ms) {
    const secs = Math.max(0, Math.round(ms / 1000));
    if (secs < 60)
        return `${secs}s`;
    const m = Math.floor(secs / 60);
    return `${m}m ${secs % 60}s`;
}
function formatCount(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
class Spinner {
    stream;
    sink;
    timer;
    frame = 0;
    label = '';
    enabled;
    // When the work being timed began — the whole turn, not this spinner run,
    // so the clock does not restart after every tool call.
    since = 0;
    // Output tokens received so far this turn (estimated), shown as "↓ 1.2k".
    tokens = 0;
    constructor(stream = process.stderr, sink) {
        this.stream = stream;
        this.sink = sink;
        this.enabled = !!stream.isTTY;
    }
    get pinned() { return !!this.sink; }
    start(label) {
        this.label = label;
        if (!this.enabled)
            return;
        if (this.timer)
            return;
        if (!this.since)
            this.since = Date.now();
        this.timer = setInterval(() => this.draw(), 120);
        this.draw();
    }
    update(label) { this.label = label; }
    get running() { return !!this.timer; }
    stop() {
        if (!this.timer)
            return;
        clearInterval(this.timer);
        this.timer = undefined;
        if (this.sink)
            this.sink('');
        else
            this.stream.write('\r\x1b[2K');
    }
    draw() {
        const glyph = exports.c.accent(FRAMES[this.frame++ % FRAMES.length]);
        const parts = [formatDuration(Date.now() - this.since)];
        if (this.tokens > 0)
            parts.push(`↓ ${formatCount(this.tokens)} tokens`);
        parts.push('esc to interrupt');
        let text = `${glyph} ${exports.c.accent(this.label)} ${exports.c.gray(`(${parts.join(' · ')})`)}`;
        if (stripAnsi(text).length > columns() - 1)
            text = `${glyph} ${exports.c.accent(this.label)}`;
        if (this.sink)
            this.sink(text);
        else
            this.stream.write(`\r\x1b[2K${text}`);
    }
}
exports.Spinner = Spinner;
// ── Markdown ─────────────────────────────────────────────────────────────────
function inline(s) {
    if (!colorOn)
        return s;
    return s
        .replace(/`([^`\n]+)`/g, (_m, code) => exports.c.cyan(code))
        .replace(/\*\*([^*\n]+)\*\*/g, (_m, b) => exports.c.bold(b))
        .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, (_m, pre, it) => `${pre}${exports.c.italic(it)}`)
        .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, (_m, text, url) => `${text} ${exports.c.gray(`(${url})`)}`);
}
// Renders the assistant's Markdown one complete line at a time, so a reply
// still appears while it streams but a `**bold**` split across two deltas is
// never printed half-styled.
class MarkdownStream {
    out;
    buf = '';
    inFence = false;
    first = true;
    constructor(out = s => process.stdout.write(s)) {
        this.out = out;
    }
    write(delta) {
        this.buf += delta;
        let nl;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
            this.emit(this.buf.slice(0, nl));
            this.buf = this.buf.slice(nl + 1);
        }
    }
    end() {
        if (this.buf)
            this.emit(this.buf);
        this.buf = '';
    }
    get started() { return !this.first; }
    emit(line) {
        // Leading blank lines before anything was said are noise.
        if (this.first && !line.trim())
            return;
        const bullet = this.first ? `${exports.c.accent('●')} ` : '  ';
        this.first = false;
        this.out(bullet + this.render(line) + '\n');
    }
    render(line) {
        const fence = /^\s*(```|~~~)/.test(line);
        if (fence) {
            this.inFence = !this.inFence;
            return exports.c.gray(line);
        }
        if (this.inFence)
            return colorOn ? exports.c.yellow(line) : line;
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading)
            return exports.c.bold(inline(heading[2]));
        const bulletLine = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        if (bulletLine)
            return `${bulletLine[1]}• ${inline(bulletLine[2])}`;
        if (/^\s*>\s?/.test(line))
            return exports.c.gray('│ ') + exports.c.italic(inline(line.replace(/^\s*>\s?/, '')));
        if (/^\s*(-{3,}|\*{3,})\s*$/.test(line))
            return exports.c.gray('─'.repeat(Math.min(60, columns() - 4)));
        return inline(line);
    }
}
exports.MarkdownStream = MarkdownStream;
// ── diffs and tool rows ──────────────────────────────────────────────────────
function colorDiff(diff, indent = '    ') {
    return diff.split('\n').map(line => {
        if (line.startsWith('+'))
            return indent + exports.c.green(line);
        if (line.startsWith('-'))
            return indent + exports.c.red(line);
        if (line.startsWith('@@'))
            return indent + exports.c.cyan(line);
        return indent + exports.c.gray(line);
    }).join('\n');
}
function toolHeader(name, summary) {
    return `${exports.c.green('●')} ${exports.c.bold(name)}${summary ? exports.c.gray(`(${summary})`) : ''}`;
}
function toolResultLine(text, isError = false) {
    const body = isError ? exports.c.red(text) : exports.c.gray(text);
    return `  ${exports.c.gray('⎿')}  ${body}`;
}
//# sourceMappingURL=ui.js.map