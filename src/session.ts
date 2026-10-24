import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage } from './client';
import { SESSIONS_DIR } from './config';

// A conversation on disk: enough to pick up where it left off with --continue
// or /resume. Sessions are grouped per project directory, so "the last one" is
// the last one *here*, not the last one anywhere.

export interface SessionFile {
  id: string;
  root: string;
  model: string;
  title: string;
  created: string;
  updated: string;
  messages: ChatMessage[];
  usage: { prompt: number; completion: number };
}

// "kedtec-1a2b3c4d": readable, and unique per absolute path. Memory (memory.ts)
// uses the same key, so a project's sessions and memory are easy to match up.
export function projectKey(root: string): string {
  const slug = path.basename(root).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'root';
  const hash = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

function projectDir(root: string): string {
  return path.join(SESSIONS_DIR, projectKey(root));
}

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export function saveSession(s: SessionFile): void {
  if (s.messages.length === 0) return;
  try {
    const dir = projectDir(s.root);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    s.updated = new Date().toISOString();
    fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s), { mode: 0o600 });
  } catch { /* a session that cannot be saved must not end the conversation */ }
}

export function listSessions(root: string): SessionFile[] {
  const dir = projectDir(root);
  let names: string[];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  const sessions: SessionFile[] = [];
  for (const n of names) {
    try { sessions.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch { /* skip a corrupt file */ }
  }
  return sessions.sort((a, b) => b.updated.localeCompare(a.updated));
}

// A new title, leaving `updated` alone: renaming is not working in it.
export function renameSession(s: SessionFile, title: string): void {
  s.title = title;
  fs.writeFileSync(path.join(projectDir(s.root), `${s.id}.json`), JSON.stringify(s), { mode: 0o600 });
}

export function deleteSession(s: SessionFile): boolean {
  try { fs.unlinkSync(path.join(projectDir(s.root), `${s.id}.json`)); return true; } catch { return false; }
}

export function loadSession(root: string, id?: string): SessionFile | undefined {
  const all = listSessions(root);
  return id ? all.find(s => s.id === id || s.id.startsWith(id)) : all[0];
}

export function titleFrom(text: string): string {
  const line = text.split('\n').find(l => l.trim()) ?? '';
  const one = line.trim().replace(/\s+/g, ' ');
  return one.length > 60 ? `${one.slice(0, 59)}…` : one || '(untitled)';
}
