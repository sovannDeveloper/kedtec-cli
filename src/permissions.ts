import { PermissionMode } from './config';
import { shellKind } from './shell';
import { tokenizeCommand } from './shellSafety';

// What a tool wants to do, as the person approving it will see it.
export interface PermissionRequest {
  kind: 'edit' | 'command' | 'outside';
  // One line: "Edit src/app.ts", "Run npm test".
  title: string;
  // A diff for an edit, the full command for a shell call.
  detail?: string;
  // Things worth reading before saying yes (paths outside the project…).
  warnings?: string[];
  // For commands: the prefix "always allow" would remember ("npm test").
  commandPrefix?: string;
  // True when the target lies outside the project root. An edit there is never
  // auto-approved; auto mode lets a read there through.
  outsideRoot?: boolean;
  // For commands and outside reads: why auto mode should still ask
  // (shellSafety.assessRisk, a credential path), or '' / absent when it may
  // run unasked.
  risk?: string;
}

export type PermissionAnswer =
  | { allow: true; always?: boolean }
  | { allow: false; feedback?: string };

export type Asker = (req: PermissionRequest) => Promise<PermissionAnswer>;

export type PermissionVerdict = { ok: true } | { ok: false; message: string };

// Executables whose first argument is a subcommand, so "always allow" should
// remember two words ("git status", "npm test") rather than the whole tool.
const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'kubectl',
  'make', 'pip', 'pip3', 'poetry', 'uv', 'dotnet', 'mvn', 'gradle', './gradlew', 'composer', 'php', 'deno',
]);

// The words of a command that is a single plain invocation — no `;`, `&&`,
// pipes, redirects or substitution — or null. Prefix allowances only ever apply
// to such a command: "npm test" must not approve "npm test && rm -rf ~".
function plainWords(command: string): string[] | null {
  // cmd.exe expands %VAR% before it looks for `&`, and `^` escapes, so neither
  // can be told apart from a chained command by the bash tokenizer below.
  if (shellKind() === 'cmd' && /[%^]/.test(command)) return null;
  const items = tokenizeCommand(command.trim());
  if (!items || items.length === 0) return null;
  if (items.some(i => i.kind === 'op')) return null;
  return items.map(i => (i.kind === 'word' ? i.text : ''));
}

export function commandPrefix(command: string): string | undefined {
  const words = plainWords(command);
  if (!words || !words[0]) return undefined;
  if (SUBCOMMAND_TOOLS.has(words[0]) && words[1] && !words[1].startsWith('-')) return `${words[0]} ${words[1]}`;
  return words[0];
}

export function matchesPrefix(command: string, prefix: string): boolean {
  const words = plainWords(command);
  const want = prefix.trim().split(/\s+/).filter(Boolean);
  if (!words || want.length === 0 || words.length < want.length) return false;
  return want.every((w, i) => words[i] === w);
}

export class Permissions {
  private sessionEdits = false;
  private readonly sessionCommands = new Set<string>();

  constructor(
    public mode: PermissionMode,
    private readonly allowedCommands: string[],
    private ask: Asker | null,
  ) {}

  setAsker(ask: Asker | null): void { this.ask = ask; }

  async check(req: PermissionRequest): Promise<PermissionVerdict> {
    if (this.mode === 'bypass') return { ok: true };

    if (this.mode === 'plan') {
      return {
        ok: false,
        message: req.kind === 'edit'
          ? 'Plan mode is read-only: files cannot be changed in this mode. Present the plan instead.'
          : req.kind === 'command'
            ? 'Plan mode only runs commands that provably read inside the project. Present the plan instead.'
            : 'Plan mode cannot reach outside the project.',
      };
    }

    if (req.kind === 'edit' && !req.outsideRoot && (this.mode === 'acceptEdits' || this.mode === 'auto' || this.sessionEdits)) return { ok: true };
    // Auto mode runs every command the risk rules do not flag; a flagged one
    // falls through to the allowances and then to the person.
    if (req.kind === 'command' && this.mode === 'auto' && !req.risk) return { ok: true };
    // So does a read outside the project, unless it is of credentials.
    if (req.kind === 'outside' && this.mode === 'auto' && !req.risk) return { ok: true };
    if (req.kind === 'command' && req.detail) {
      const command = req.detail;
      for (const prefix of [...this.allowedCommands, ...this.sessionCommands]) {
        if (matchesPrefix(command, prefix)) return { ok: true };
      }
    }

    if (!this.ask) {
      return {
        ok: false,
        message: req.risk && this.mode === 'auto'
          ? `Permission denied: auto mode still asks before this (${req.risk}), and this run is non-interactive. `
            + 'Do it another way, or the user can add the command prefix to allowedCommands or use bypass.'
          : `Permission denied: "${req.title}" needs approval, and this run is non-interactive. `
            + 'Re-run with --permission-mode acceptEdits (file edits), auto (edits and low-risk commands) or bypass, or add the command prefix to allowedCommands.',
      };
    }

    const answer = await this.ask(req);
    if (!answer.allow) {
      const feedback = answer.feedback?.trim();
      return {
        ok: false,
        message: feedback
          ? `The user declined this and said: ${feedback}`
          : 'The user declined this action. Do not retry it; ask what they would like instead, or continue without it.',
      };
    }
    if (answer.always) {
      if (req.kind === 'edit') this.sessionEdits = true;
      if (req.kind === 'command' && req.commandPrefix) this.sessionCommands.add(req.commandPrefix);
    }
    return { ok: true };
  }
}
