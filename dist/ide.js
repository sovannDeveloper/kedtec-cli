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
exports.IdeContext = exports.IdeWatcher = void 0;
exports.selectedRanges = selectedRanges;
exports.ideLabel = ideLabel;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
// What is selected, all of it: `selections` when the extension sends it, else
// the one primary selection. Reading `selection` alone is how a second range
// selected with alt+click never reached the model.
function selectedRanges(state) {
    if (!state)
        return [];
    const all = Array.isArray(state.selections) ? state.selections : state.selection ? [state.selection] : [];
    return all.filter(r => r && typeof r.text === 'string' && r.text.trim());
}
function lineCount(ranges) {
    return ranges.reduce((n, r) => n + r.endLine - r.startLine + 1, 0);
}
// KEDTEC_IDE_DIR exists for tests; the extension always writes to ~/.kedtec/ide.
const IDE_DIR = process.env.KEDTEC_IDE_DIR || path.join(os.homedir(), '.kedtec', 'ide');
const POLL_MS = 1500;
function inside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
}
class IdeWatcher {
    root;
    onChange;
    state = null;
    watcher;
    poll;
    key = '';
    constructor(root, onChange) {
        this.root = root;
        this.onChange = onChange;
    }
    start() {
        this.read();
        // fs.watch is fast but can miss a rename or stop on some filesystems; the
        // poll is the backstop, and it also notices a window that has closed.
        try {
            fs.mkdirSync(IDE_DIR, { recursive: true, mode: 0o700 });
            this.watcher = fs.watch(IDE_DIR, () => this.read());
        }
        catch { /* polling alone still works */ }
        this.poll = setInterval(() => this.read(), POLL_MS);
        this.poll.unref();
    }
    stop() {
        this.watcher?.close();
        if (this.poll)
            clearInterval(this.poll);
    }
    read() {
        let best = null;
        let names = [];
        try {
            names = fs.readdirSync(IDE_DIR).filter(n => n.endsWith('.json'));
        }
        catch { /* no extension yet */ }
        for (const name of names) {
            let s;
            try {
                s = JSON.parse(fs.readFileSync(path.join(IDE_DIR, name), 'utf8'));
            }
            catch {
                continue;
            }
            if (!s || typeof s.pid !== 'number' || !Array.isArray(s.workspaceFolders) || !alive(s.pid))
                continue;
            const matches = s.workspaceFolders.some(f => inside(this.root, f) || inside(f, this.root));
            if (matches && (!best || s.updated > best.updated))
                best = s;
        }
        const key = best ? `${best.file}|${selectedRanges(best).map(r => `${r.startLine}-${r.endLine}:${r.text.length}`).join(',')}` : '';
        if (key === this.key)
            return;
        this.key = key;
        this.state = best;
        this.onChange(best);
    }
}
exports.IdeWatcher = IdeWatcher;
// "⧉ In ui.ts", "⧉ 12 lines selected" or "⧉ 18 lines in 2 selections", for the status line.
function ideLabel(state) {
    if (!state?.file)
        return '';
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
class IdeContext {
    root;
    lastSent = '';
    constructor(root) {
        this.root = root;
    }
    forMessage(state) {
        if (!state?.file)
            return null;
        const rel = inside(state.file, this.root) ? path.relative(this.root, state.file) : state.file;
        const ranges = selectedRanges(state);
        const digest = crypto.createHash('sha1')
            .update(`${state.file}\0${ranges.map(r => `${r.startLine}-${r.endLine}\0${r.text}`).join('\0')}`).digest('hex');
        if (digest === this.lastSent)
            return null;
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
exports.IdeContext = IdeContext;
//# sourceMappingURL=ide.js.map