import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Images in a message: pasted from the clipboard (ctrl+v in the input box), a
// file dragged onto the terminal (which pastes its path), or "@shot.png". They
// go to the model as Chat Completions image_url parts, inline as data URLs.

export interface ImageAttachment {
  mediaType: string;
  data: string; // base64
  bytes: number;
}

// Most vision backends refuse an image over 5 MB. A bigger one is scaled down
// where the system can (sips on a Mac), and refused otherwise.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SCALE_TO_PX = 2000;
const CLIPBOARD_TIMEOUT_MS = 5000;

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export function isImagePath(p: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase());
}

// The format from the file's first bytes, not its name.
export function sniffMediaType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function fromBuffer(buf: Buffer): ImageAttachment | null {
  const mediaType = sniffMediaType(buf);
  return mediaType ? { mediaType, data: buf.toString('base64'), bytes: buf.length } : null;
}

// An image file, scaled down first if it is too big to send. A string is the
// reason it cannot be attached.
export async function imageFromFile(abs: string): Promise<ImageAttachment | string> {
  let buf: Buffer;
  try { buf = fs.readFileSync(abs); } catch (err) { return (err as Error).message; }
  if (buf.length > MAX_IMAGE_BYTES) buf = (await shrink(buf)) ?? buf;
  if (buf.length > MAX_IMAGE_BYTES) return `${(buf.length / 1024 / 1024).toFixed(1)} MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`;
  return fromBuffer(buf) ?? 'not a PNG, JPEG, GIF or WebP image';
}

// The image on the clipboard, or null when there is none (or no way to read it).
export async function clipboardImage(): Promise<ImageAttachment | string | null> {
  const tmp = path.join(os.tmpdir(), `kedtec-clip-${crypto.randomBytes(4).toString('hex')}.png`);
  try {
    if (process.platform === 'darwin') {
      // A file copied in Finder is the file itself, not its icon.
      const copied = (await run('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)']))?.toString('utf8').trim();
      if (copied && isImagePath(copied)) return imageFromFile(copied);
      const script = [
        `set f to open for access POSIX file "${tmp}" with write permission`,
        'try',
        '  write (the clipboard as «class PNGf») to f',
        'end try',
        'close access f',
      ];
      await run('osascript', script.flatMap(l => ['-e', l]));
    } else if (process.platform === 'win32') {
      const ps = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; '
        + '$i = [System.Windows.Forms.Clipboard]::GetImage(); '
        + `if ($i) { $i.Save('${tmp.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png) }`;
      await run('powershell', ['-NoProfile', '-STA', '-Command', ps]);
    } else {
      const out = (process.env.WAYLAND_DISPLAY ? await run('wl-paste', ['--no-newline', '--type', 'image/png']) : null)
        ?? await run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']);
      if (out?.length) fs.writeFileSync(tmp, out);
    }
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) return null;
    return imageFromFile(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
  }
}

// A dragged-in file arrives as its path, pasted: quoted, or with spaces
// backslash-escaped, or as a file:// URL. The image files a paste names, or
// null when it is anything other than paths to existing images.
export function pastedImagePaths(text: string): string[] | null {
  const words: string[] = [];
  for (const m of text.trim().matchAll(/'([^']*)'|"([^"]*)"|((?:\\.|[^\s'"\\])+)/g)) {
    words.push(m[1] ?? m[2] ?? m[3].replace(/\\(.)/g, '$1'));
  }
  if (words.length === 0) return null;
  const paths: string[] = [];
  for (let w of words) {
    if (w.startsWith('file://')) { try { w = decodeURIComponent(new URL(w).pathname); } catch { return null; } }
    if (w.startsWith('~/')) w = path.join(os.homedir(), w.slice(2));
    const abs = path.resolve(w);
    if (!isImagePath(abs)) return null;
    try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
    paths.push(abs);
  }
  return paths;
}

export function dataUrl(img: ImageAttachment): string {
  return `data:${img.mediaType};base64,${img.data}`;
}

async function shrink(buf: Buffer): Promise<Buffer | null> {
  if (process.platform !== 'darwin') return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kedtec-img-'));
  try {
    const src = path.join(dir, 'in');
    const out = path.join(dir, 'out.jpg');
    fs.writeFileSync(src, buf);
    await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', String(SCALE_TO_PX), src, '--out', out]);
    return fs.existsSync(out) ? fs.readFileSync(out) : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A helper's stdout, or null when it is missing, fails or takes too long.
function run(file: string, args: string[]): Promise<Buffer | null> {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'buffer', timeout: CLIPBOARD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout));
  });
}
