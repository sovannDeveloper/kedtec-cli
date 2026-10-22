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
exports.newSessionId = newSessionId;
exports.saveSession = saveSession;
exports.listSessions = listSessions;
exports.loadSession = loadSession;
exports.titleFrom = titleFrom;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("./config");
function projectDir(root) {
    const slug = path.basename(root).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'root';
    const hash = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 8);
    return path.join(config_1.SESSIONS_DIR, `${slug}-${hash}`);
}
function newSessionId() {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}
function saveSession(s) {
    if (s.messages.length === 0)
        return;
    try {
        const dir = projectDir(s.root);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        s.updated = new Date().toISOString();
        fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s), { mode: 0o600 });
    }
    catch { /* a session that cannot be saved must not end the conversation */ }
}
function listSessions(root) {
    const dir = projectDir(root);
    let names;
    try {
        names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
    }
    catch {
        return [];
    }
    const sessions = [];
    for (const n of names) {
        try {
            sessions.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
        }
        catch { /* skip a corrupt file */ }
    }
    return sessions.sort((a, b) => b.updated.localeCompare(a.updated));
}
function loadSession(root, id) {
    const all = listSessions(root);
    return id ? all.find(s => s.id === id || s.id.startsWith(id)) : all[0];
}
function titleFrom(text) {
    const line = text.split('\n').find(l => l.trim()) ?? '';
    const one = line.trim().replace(/\s+/g, ' ');
    return one.length > 60 ? `${one.slice(0, 59)}…` : one || '(untitled)';
}
//# sourceMappingURL=session.js.map