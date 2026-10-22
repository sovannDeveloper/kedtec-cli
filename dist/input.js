"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TurnKeys = exports.LineInput = exports.HISTORY_SIZE = void 0;
exports.installInputFilter = installInputFilter;
exports.keyStream = keyStream;
exports.expectReport = expectReport;
exports.loadHistory = loadHistory;
exports.saveHistory = saveHistory;
exports.select = select;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
const stream_1 = require("stream");
const config_1 = require("./config");
const ui_1 = require("./ui");
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
let filtered = null;
let reportsExpected = 0;
function installInputFilter(onWheel) {
    if (filtered)
        return;
    const out = new stream_1.PassThrough();
    filtered = out;
    let pending = '';
    process.stdin.on('data', (d) => {
        let s = pending + d.toString('utf8');
        pending = '';
        // A report split across two reads: hold its head until the rest arrives.
        // Only a report's own prefix is held — never a lone Esc, which is a key.
        const head = reportsExpected > 0 ? /\x1b\[(<[\d;]*|\d+;?\d*)$/ : /\x1b\[<[\d;]*$/;
        const cut = s.search(head);
        if (cut >= 0) {
            pending = s.slice(cut);
            s = s.slice(0, cut);
        }
        s = s.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (_m, button) => {
            const b = Number(button) & ~(4 | 8 | 16); // ignore shift/alt/ctrl bits
            if (b === 64)
                onWheel(-1);
            else if (b === 65)
                onWheel(1);
            return '';
        });
        if (reportsExpected > 0) {
            s = s.replace(/\x1b\[\d+;\d+R/g, () => { reportsExpected = Math.max(0, reportsExpected - 1); return ''; });
        }
        if (s)
            out.write(s);
    });
}
function keyStream() {
    return filtered ?? process.stdin;
}
// A cursor position report is on its way; the filter swallows it.
function expectReport() {
    reportsExpected++;
    setTimeout(() => { reportsExpected = Math.max(0, reportsExpected - 1); }, 1000).unref();
}
const HISTORY_FILE = path.join(config_1.HOME_DIR, 'history');
exports.HISTORY_SIZE = 500;
// Newest first. Shared by LineInput and the pinned input box in screen.ts.
function loadHistory() {
    try {
        return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).reverse().slice(0, exports.HISTORY_SIZE);
    }
    catch {
        return [];
    }
}
function saveHistory(history) {
    try {
        fs.mkdirSync(config_1.HOME_DIR, { recursive: true, mode: 0o700 });
        // One entry per line, so multi-line prompts are kept as their first line only.
        const lines = history.slice(0, exports.HISTORY_SIZE).map(h => h.split('\n')[0]).reverse();
        fs.writeFileSync(HISTORY_FILE, lines.join('\n') + '\n', { mode: 0o600 });
    }
    catch { /* history is a convenience */ }
}
class LineInput {
    history = loadHistory();
    saveHistory() {
        saveHistory(this.history);
    }
    // One prompt. A line ending in "\" continues on the next line, and lines that
    // arrive together (a paste) are joined into one message rather than sent as
    // several.
    ask(prompt, opts = {}) {
        const useHistory = opts.history !== false;
        const multiline = opts.multiline !== false;
        return new Promise(resolve => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: true,
                history: useHistory ? [...this.history] : [],
                historySize: useHistory ? exports.HISTORY_SIZE : 0,
                removeHistoryDuplicates: true,
                prompt,
            });
            // A secret is echoed as one * per character once the prompt is on screen,
            // so a paste visibly landed without the key itself being shown.
            let muted = false;
            if (opts.secret) {
                const mask = (s) => s.replace(/[^\r\n]/gu, '*');
                const anyRl = rl;
                anyRl._writeToOutput = (s) => {
                    if (!muted)
                        return void process.stdout.write(s);
                    // A redraw (backspace, cursor keys) writes the prompt and the whole line together.
                    const p = rl.getPrompt();
                    process.stdout.write(s.startsWith(p) ? p + mask(s.slice(p.length)) : mask(s));
                };
            }
            if (useHistory)
                rl.on('history', (h) => { this.history = h; });
            const lines = [];
            let timer;
            let done = false;
            const finish = (result) => {
                if (done)
                    return;
                done = true;
                if (timer)
                    clearTimeout(timer);
                rl.close();
                if (result.kind === 'line' && useHistory && result.text.trim()) {
                    this.history = [result.text, ...this.history.filter(h => h !== result.text)].slice(0, exports.HISTORY_SIZE);
                    this.saveHistory();
                }
                resolve(result);
            };
            rl.on('line', line => {
                if (multiline && line.endsWith('\\')) {
                    lines.push(line.slice(0, -1));
                    rl.setPrompt(ui_1.c.gray('… '));
                    rl.prompt();
                    return;
                }
                lines.push(line);
                if (timer)
                    clearTimeout(timer);
                timer = setTimeout(() => finish({ kind: 'line', text: lines.join('\n') }), multiline ? 20 : 0);
            });
            rl.on('SIGINT', () => {
                // ctrl+c on a half-typed line clears it, like a shell.
                if (rl.line || lines.length > 0) {
                    lines.length = 0;
                    rl.line = '';
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
exports.LineInput = LineInput;
// An arrow-key menu. Resolves with the chosen index, or null for Esc / ctrl+c.
function select(options, initial = 0, { numbered = true, indent = '  ', footer } = {}) {
    return new Promise(resolve => {
        const stdin = process.stdin;
        const keys = keyStream();
        readline.emitKeypressEvents(keys);
        const wasRaw = !!stdin.isRaw;
        if (stdin.isTTY)
            stdin.setRawMode(true);
        stdin.resume();
        let idx = Math.max(0, Math.min(options.length - 1, initial));
        // A footer sits under the options and is redrawn with them: a blank line, then the text.
        const footerLines = footer ? 2 : 0;
        const render = (first) => {
            if (!first)
                process.stdout.write(`\x1b[${options.length + footerLines}A`);
            options.forEach((opt, i) => {
                const label = numbered ? `${i + 1}. ${opt}` : opt;
                const line = i === idx ? `${ui_1.c.accent('❯')} ${ui_1.c.accent(label)}` : numbered ? `  ${ui_1.c.gray(`${i + 1}.`)} ${opt}` : `  ${opt}`;
                process.stdout.write(`\x1b[2K${indent}${line}\n`);
            });
            if (footer)
                process.stdout.write(`\x1b[2K\n\x1b[2K${indent}${footer}\n`);
        };
        const done = (value) => {
            keys.off('keypress', onKey);
            if (stdin.isTTY)
                stdin.setRawMode(wasRaw);
            stdin.pause();
            resolve(value);
        };
        const onKey = (str, key) => {
            if ((key?.ctrl && key.name === 'c') || key?.name === 'escape')
                return done(null);
            if (key?.name === 'up' || key?.name === 'k')
                idx = (idx - 1 + options.length) % options.length;
            else if (key?.name === 'down' || key?.name === 'j' || key?.name === 'tab')
                idx = (idx + 1) % options.length;
            else if (key?.name === 'return' || key?.name === 'enter')
                return done(idx);
            else if (str && /^[1-9]$/.test(str) && Number(str) <= options.length)
                return done(Number(str) - 1);
            else
                return;
            render(false);
        };
        keys.on('keypress', onKey);
        render(true);
    });
}
// While a turn runs: swallow typing, turn Esc or ctrl+c into an interrupt, and
// pass on the few keys that still mean something (shift+tab, page up/down).
class TurnKeys {
    onInterrupt;
    onShiftTab;
    onPage;
    active = false;
    onData = (buf) => {
        const s = buf.toString();
        if (s === '\x03' || s === '\x1b')
            this.onInterrupt();
        else if (s === '\x1b[Z')
            this.onShiftTab?.();
        else if (s === '\x1b[5~')
            this.onPage?.(-1);
        else if (s === '\x1b[6~')
            this.onPage?.(1);
    };
    constructor(onInterrupt, onShiftTab, onPage) {
        this.onInterrupt = onInterrupt;
        this.onShiftTab = onShiftTab;
        this.onPage = onPage;
    }
    start() {
        if (!process.stdin.isTTY || this.active)
            return;
        this.active = true;
        process.stdin.setRawMode(true);
        keyStream().on('data', this.onData);
        process.stdin.resume();
    }
    stop() {
        if (!this.active)
            return;
        this.active = false;
        keyStream().off('data', this.onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
    }
    // For a permission prompt in the middle of a turn, which needs the keys itself.
    async suspend(fn) {
        const was = this.active;
        this.stop();
        try {
            return await fn();
        }
        finally {
            if (was)
                this.start();
        }
    }
}
exports.TurnKeys = TurnKeys;
//# sourceMappingURL=input.js.map