import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Where everything this CLI keeps lives: the config file (endpoint, key,
// model), saved sessions and the global instructions file. One directory so
// that "reset kedtec" is one `rm -rf`. KEDTEC_HOME moves it, which is what
// a CI runner with a read-only home directory needs.
export const HOME_DIR = process.env.KEDTEC_HOME || path.join(os.homedir(), '.kedtec');
export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
export const SESSIONS_DIR = path.join(HOME_DIR, 'sessions');

// The same default the VS Code extension ships with: the KEDTec front door,
// which reverse-proxies /v1 to the API. Any OpenAI-compatible base URL works.
export const DEFAULT_ENDPOINT = 'http://192.168.129.69:3000/v1';

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypass';
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan', 'bypass'];

export function normalizeMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v === 'bypassPermissions' || v === 'yolo') return 'bypass';
  return PERMISSION_MODES.find(m => m.toLowerCase() === v.toLowerCase());
}

export interface StoredConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  permissionMode?: PermissionMode;
  // Command prefixes that run without asking ("npm test", "git status").
  allowedCommands?: string[];
}

export interface ResolvedConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  permissionMode: PermissionMode;
  allowedCommands: string[];
}

export function readStoredConfig(): StoredConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as StoredConfig : {};
  } catch {
    return {};
  }
}

// The file holds an API key, so it is written owner-only. mkdir's mode is
// applied before umask, which is why the chmod follows rather than relying on it.
export function writeStoredConfig(config: StoredConfig): void {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* not every filesystem has modes */ }
}

// A project may pre-approve commands for everyone working in it:
// <root>/.kedtec/settings.json → { "allowedCommands": ["npm test"] }.
// Only allowances are read from there — never an endpoint or a key, since a
// repository someone else wrote must not be able to point this CLI elsewhere.
export function readProjectAllowedCommands(root: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, '.kedtec', 'settings.json'), 'utf8'));
    return Array.isArray(parsed?.allowedCommands) ? parsed.allowedCommands.filter((s: unknown) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

export interface ConfigOverrides {
  endpoint?: string;
  model?: string;
  permissionMode?: PermissionMode;
  maxTokens?: number;
}

// Precedence: command-line flag, then environment, then the config file, then
// the default. Environment beats the file so a CI job can configure everything
// through secrets without writing anything to disk.
export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const stored = readStoredConfig();
  const endpoint = (overrides.endpoint
    ?? env('KEDTEC_ENDPOINT', 'KEDTEC_BASE_URL', 'OPENAI_BASE_URL')
    ?? stored.endpoint
    ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  return {
    endpoint,
    apiKey: env('KEDTEC_API_KEY', 'OPENAI_API_KEY') ?? stored.apiKey ?? '',
    model: overrides.model ?? env('KEDTEC_MODEL') ?? stored.model ?? '',
    maxTokens: Math.max(256, Math.min(200000,
      overrides.maxTokens ?? finiteNumber(env('KEDTEC_MAX_TOKENS')) ?? finiteNumber(stored.maxTokens) ?? 16384)),
    temperature: Math.max(0, Math.min(2, finiteNumber(stored.temperature) ?? 0.2)),
    permissionMode: overrides.permissionMode
      ?? normalizeMode(env('KEDTEC_PERMISSION_MODE'))
      ?? normalizeMode(stored.permissionMode)
      ?? 'default',
    allowedCommands: Array.isArray(stored.allowedCommands) ? stored.allowedCommands : [],
  };
}

export function maskKey(key: string): string {
  if (!key) return '(not set)';
  return key.length <= 10 ? '••••' : `${key.slice(0, 6)}…${key.slice(-4)}`;
}
