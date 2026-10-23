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
exports.TRUST_FILE = void 0;
exports.readTrusted = readTrusted;
exports.isTrusted = isTrusted;
exports.canRemember = canRemember;
exports.addTrusted = addTrusted;
exports.confirmTrust = confirmTrust;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const config_1 = require("./config");
const input_1 = require("./input");
const ui_1 = require("./ui");
// Before the first interactive session in a folder, ask whether it is one the
// user trusts. The agent reads, edits and runs commands there, and a project
// can pre-approve commands for itself (.kedtec/settings.json), so a cloned
// repository nobody has looked at should not get that on the strength of a
// `cd`. The answer is remembered per folder and covers everything below it.
exports.TRUST_FILE = path.join(config_1.HOME_DIR, 'trusted.json');
function real(dir) {
    try {
        return fs.realpathSync(dir);
    }
    catch {
        return path.resolve(dir);
    }
}
function inside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function readTrusted(file = exports.TRUST_FILE) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed?.folders) ? parsed.folders.filter((s) => typeof s === 'string') : [];
    }
    catch {
        return [];
    }
}
function isTrusted(dir, file = exports.TRUST_FILE) {
    const target = real(dir);
    return readTrusted(file).some(t => inside(target, t));
}
// Trusting the home directory or the filesystem root would trust every
// project below it, so those answers last for this session only.
function canRemember(dir) {
    const target = real(dir);
    return target !== real(os.homedir()) && target !== path.parse(target).root;
}
function addTrusted(dir, file = exports.TRUST_FILE) {
    const target = real(dir);
    const folders = readTrusted(file).filter(t => t !== target);
    folders.push(target);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ folders }, null, 2) + '\n', { mode: 0o600 });
}
// true to carry on; false when the user declined or cancelled.
async function confirmTrust(root) {
    if (isTrusted(root))
        return true;
    const width = (0, ui_1.columns)();
    const out = process.stdout;
    out.write(`${ui_1.c.yellow('─'.repeat(width))}\n`);
    out.write(`${ui_1.c.bold(ui_1.c.yellow('Accessing workspace:'))}\n\n`);
    out.write(`${ui_1.c.bold(real(root))}\n\n`);
    out.write(`${(0, ui_1.wrapText)("Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.", width)}\n\n`);
    out.write(`${(0, ui_1.wrapText)("KEDTec'll be able to read, edit, and execute files here.", width)}\n\n`);
    const choice = await (0, input_1.select)(['No, exit', 'Yes, I trust this folder'], 0, { numbered: false, indent: '', footer: ui_1.c.gray('Enter to confirm · Esc to cancel') });
    if (choice !== 1)
        return false;
    if (canRemember(root))
        addTrusted(root);
    else
        out.write(`${ui_1.c.gray('Trusted for this session only — the home directory and / are never remembered.')}\n`);
    return true;
}
//# sourceMappingURL=trust.js.map