import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatViewProvider } from './chat';

// Two things live here. The chat panel (chat.ts) runs the CLI's agent inside
// the editor. And the bridge, below, tells the `kedtec` terminal CLI which file
// is open in this window and what is selected in it, so the CLI can show
// "⧉ In ui.ts" / "⧉ 12 lines selected" under its input box and hand the
// selection to the model with the next message; the chat panel sends the same.
// The CLI installs this extension itself (src/ideBridge.ts) when it runs in a
// VS Code terminal and finds it missing.
//
// The channel is one JSON file per window under ~/.kedtec/ide/, named after
// this extension host's pid. A file rather than a socket: the CLI only ever
// reads the latest state, a file needs no port or handshake, and a CLI started
// after the window opened finds it without anything having to be listening.
// The pid in the file lets the CLI ignore one a crashed window left behind.

const IDE_DIR = path.join(os.homedir(), '.kedtec', 'ide');
const STATE_FILE = path.join(IDE_DIR, `${process.pid}.json`);
const DEBOUNCE_MS = 150;
// A selection is context for one message, not a document to ship whole.
const MAX_SELECTION_CHARS = 20_000;

interface BridgeState {
  pid: number;
  workspaceFolders: string[];
  file: string | null;
  // The primary selection, kept for a CLI that predates `selections`.
  selection: Range | null;
  // Every selection in the editor (alt+click / ctrl+d make several), top to bottom.
  selections: Range[];
  updated: number;
}

interface Range { startLine: number; endLine: number; text: string }

let lastFile: string | null = null;
let lastSelection: Range | null = null;
let lastSelections: Range[] = [];
let timer: NodeJS.Timeout | undefined;

function snapshot(editor: vscode.TextEditor | undefined): void {
  // Focusing the terminal leaves no active editor; the file the person was
  // just looking at is still the one they mean, so keep it.
  if (!editor || editor.document.uri.scheme !== 'file') return;
  lastFile = editor.document.uri.fsPath;
  const doc = editor.document;
  // A selection ending at column 0 of the next line does not include it.
  const toRange = (sel: vscode.Selection): Range => ({
    startLine: sel.start.line + 1,
    endLine: sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1,
    text: doc.getText(sel),
  });
  const ranges = editor.selections.filter(s => !s.isEmpty).sort((a, b) => a.start.compareTo(b.start)).map(toRange);
  // The cap is on the whole set, so ten selections cannot ship ten times as much.
  let budget = MAX_SELECTION_CHARS;
  lastSelections = [];
  for (const r of ranges) {
    if (budget <= 0) break;
    lastSelections.push({ ...r, text: r.text.slice(0, budget) });
    budget -= r.text.length;
  }
  lastSelection = editor.selection.isEmpty ? null : { ...toRange(editor.selection), text: doc.getText(editor.selection).slice(0, MAX_SELECTION_CHARS) };
}

// What the CLI reads from the state file, and what the chat panel sends with a message.
function state(): BridgeState {
  return {
    pid: process.pid,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
    file: lastFile,
    selection: lastSelection,
    selections: lastSelections,
    updated: Date.now(),
  };
}

function write(): void {
  const json = JSON.stringify(state());
  const tmp = `${STATE_FILE}.tmp`;
  try {
    fs.mkdirSync(IDE_DIR, { recursive: true, mode: 0o700 });
    // Written aside and renamed, so a CLI reading mid-write never sees half a file.
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // On Windows the rename fails with EPERM/EBUSY while the CLI or a virus
    // scanner has the file open. Write it in place instead: a CLI that catches
    // it half-written skips it and reads it again on its next poll.
    try {
      fs.writeFileSync(STATE_FILE, json, { mode: 0o600 });
    } catch {
      // The bridge is a convenience; a read-only home must not break the window.
    }
    try { fs.unlinkSync(tmp); } catch { /* never written, or already renamed */ }
  }
}

let chat: ChatViewProvider | undefined;

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { write(); chat?.editorChanged(); }, DEBOUNCE_MS);
}

export function activate(context: vscode.ExtensionContext): void {
  snapshot(vscode.window.activeTextEditor);
  write();
  chat = new ChatViewProvider(context, state);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('kedtec.newChat', () => chat?.newChat()),
    vscode.commands.registerCommand('kedtec.history', () => chat?.showHistory()),
    vscode.commands.registerCommand('kedtec.signIn', () => chat?.signIn()),
    vscode.commands.registerCommand('kedtec.reload', () => chat?.reload()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => chat?.reload()),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => { snapshot(editor); schedule(); }),
    vscode.window.onDidChangeTextEditorSelection(e => { snapshot(e.textEditor); schedule(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => schedule()),
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (doc.uri.fsPath === lastFile && !vscode.window.visibleTextEditors.some(e => e.document.uri.fsPath === lastFile)) {
        lastFile = null;
        lastSelection = null;
        lastSelections = [];
        schedule();
      }
    }),
  );
}

export function deactivate(): void {
  if (timer) clearTimeout(timer);
  try { fs.unlinkSync(STATE_FILE); } catch { /* already gone */ }
}
