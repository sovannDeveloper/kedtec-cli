import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOME_DIR } from './config';
import { select } from './input';
import { c, columns } from './ui';

// Before the first interactive session in a folder, ask whether it is one the
// user trusts. The agent reads, edits and runs commands there, and a project
// can pre-approve commands for itself (.kedtec/settings.json), so a cloned
// repository nobody has looked at should not get that on the strength of a
// `cd`. The answer is remembered per folder and covers everything below it.
export const TRUST_FILE = path.join(HOME_DIR, 'trusted.json');

function real(dir: string): string {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function readTrusted(file = TRUST_FILE): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.folders) ? parsed.folders.filter((s: unknown) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function isTrusted(dir: string, file = TRUST_FILE): boolean {
  const target = real(dir);
  return readTrusted(file).some(t => inside(target, t));
}

// Trusting the home directory or the filesystem root would trust every
// project below it, so those answers last for this session only.
export function canRemember(dir: string): boolean {
  const target = real(dir);
  return target !== real(os.homedir()) && target !== path.parse(target).root;
}

export function addTrusted(dir: string, file = TRUST_FILE): void {
  const target = real(dir);
  const folders = readTrusted(file).filter(t => t !== target);
  folders.push(target);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ folders }, null, 2) + '\n', { mode: 0o600 });
}

function wrapText(text: string, width: number): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

// true to carry on; false when the user declined or cancelled.
export async function confirmTrust(root: string): Promise<boolean> {
  if (isTrusted(root)) return true;
  const width = columns();
  const out = process.stdout;
  out.write(`${c.yellow('─'.repeat(width))}\n`);
  out.write(`${c.bold(c.yellow('Accessing workspace:'))}\n\n`);
  out.write(`${c.bold(real(root))}\n\n`);
  out.write(`${wrapText("Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.", width)}\n\n`);
  out.write(`${wrapText("KEDTec'll be able to read, edit, and execute files here.", width)}\n\n`);
  const choice = await select(['No, exit', 'Yes, I trust this folder'], 0,
    { numbered: false, indent: '', footer: c.gray('Enter to confirm · Esc to cancel') });
  if (choice !== 1) return false;
  if (canRemember(root)) addTrusted(root);
  else out.write(`${c.gray('Trusted for this session only — the home directory and / are never remembered.')}\n`);
  return true;
}
