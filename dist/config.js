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
exports.PERMISSION_MODES = exports.DEFAULT_ENDPOINT = exports.SESSIONS_DIR = exports.CONFIG_FILE = exports.HOME_DIR = void 0;
exports.normalizeMode = normalizeMode;
exports.readStoredConfig = readStoredConfig;
exports.writeStoredConfig = writeStoredConfig;
exports.readProjectAllowedCommands = readProjectAllowedCommands;
exports.resolveConfig = resolveConfig;
exports.maskKey = maskKey;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
// Where everything this CLI keeps lives: the config file (endpoint, key,
// model), saved sessions and the global instructions file. One directory so
// that "reset kedtec" is one `rm -rf`. KEDTEC_HOME moves it, which is what
// a CI runner with a read-only home directory needs.
exports.HOME_DIR = process.env.KEDTEC_HOME || path.join(os.homedir(), '.kedtec');
exports.CONFIG_FILE = path.join(exports.HOME_DIR, 'config.json');
exports.SESSIONS_DIR = path.join(exports.HOME_DIR, 'sessions');
// The same default the VS Code extension ships with: the KEDTec front door,
// which reverse-proxies /v1 to the API. Any OpenAI-compatible base URL works.
exports.DEFAULT_ENDPOINT = 'http://192.168.129.69:3000/v1';
exports.PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypass'];
function normalizeMode(value) {
    if (typeof value !== 'string')
        return undefined;
    const v = value.trim();
    if (v === 'bypassPermissions' || v === 'yolo')
        return 'bypass';
    return exports.PERMISSION_MODES.find(m => m.toLowerCase() === v.toLowerCase());
}
function readStoredConfig() {
    try {
        const parsed = JSON.parse(fs.readFileSync(exports.CONFIG_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
// The file holds an API key, so it is written owner-only. mkdir's mode is
// applied before umask, which is why the chmod follows rather than relying on it.
function writeStoredConfig(config) {
    fs.mkdirSync(exports.HOME_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(exports.CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    try {
        fs.chmodSync(exports.CONFIG_FILE, 0o600);
    }
    catch { /* not every filesystem has modes */ }
}
// A project may pre-approve commands for everyone working in it:
// <root>/.kedtec/settings.json → { "allowedCommands": ["npm test"] }.
// Only allowances are read from there — never an endpoint or a key, since a
// repository someone else wrote must not be able to point this CLI elsewhere.
function readProjectAllowedCommands(root) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(root, '.kedtec', 'settings.json'), 'utf8'));
        return Array.isArray(parsed?.allowedCommands) ? parsed.allowedCommands.filter((s) => typeof s === 'string') : [];
    }
    catch {
        return [];
    }
}
function env(...names) {
    for (const n of names) {
        const v = process.env[n];
        if (v && v.trim())
            return v.trim();
    }
    return undefined;
}
function finiteNumber(value) {
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
// Precedence: command-line flag, then environment, then the config file, then
// the default. Environment beats the file so a CI job can configure everything
// through secrets without writing anything to disk.
function resolveConfig(overrides = {}) {
    const stored = readStoredConfig();
    const endpoint = (overrides.endpoint
        ?? env('KEDTEC_ENDPOINT', 'KEDTEC_BASE_URL', 'OPENAI_BASE_URL')
        ?? stored.endpoint
        ?? exports.DEFAULT_ENDPOINT).replace(/\/+$/, '');
    return {
        endpoint,
        apiKey: env('KEDTEC_API_KEY', 'OPENAI_API_KEY') ?? stored.apiKey ?? '',
        model: overrides.model ?? env('KEDTEC_MODEL') ?? stored.model ?? '',
        maxTokens: Math.max(256, Math.min(200000, overrides.maxTokens ?? finiteNumber(env('KEDTEC_MAX_TOKENS')) ?? finiteNumber(stored.maxTokens) ?? 16384)),
        temperature: Math.max(0, Math.min(2, finiteNumber(stored.temperature) ?? 0.2)),
        permissionMode: overrides.permissionMode
            ?? normalizeMode(env('KEDTEC_PERMISSION_MODE'))
            ?? normalizeMode(stored.permissionMode)
            ?? 'default',
        allowedCommands: Array.isArray(stored.allowedCommands) ? stored.allowedCommands : [],
    };
}
function maskKey(key) {
    if (!key)
        return '(not set)';
    return key.length <= 10 ? '••••' : `${key.slice(0, 6)}…${key.slice(-4)}`;
}
//# sourceMappingURL=config.js.map