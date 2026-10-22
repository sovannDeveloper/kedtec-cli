"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Permissions = void 0;
exports.commandPrefix = commandPrefix;
exports.matchesPrefix = matchesPrefix;
const shell_1 = require("./shell");
const shellSafety_1 = require("./shellSafety");
// Executables whose first argument is a subcommand, so "always allow" should
// remember two words ("git status", "npm test") rather than the whole tool.
const SUBCOMMAND_TOOLS = new Set([
    'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'kubectl',
    'make', 'pip', 'pip3', 'poetry', 'uv', 'dotnet', 'mvn', 'gradle', './gradlew', 'composer', 'php', 'deno',
]);
// The words of a command that is a single plain invocation — no `;`, `&&`,
// pipes, redirects or substitution — or null. Prefix allowances only ever apply
// to such a command: "npm test" must not approve "npm test && rm -rf ~".
function plainWords(command) {
    // cmd.exe expands %VAR% before it looks for `&`, and `^` escapes, so neither
    // can be told apart from a chained command by the bash tokenizer below.
    if ((0, shell_1.shellKind)() === 'cmd' && /[%^]/.test(command))
        return null;
    const items = (0, shellSafety_1.tokenizeCommand)(command.trim());
    if (!items || items.length === 0)
        return null;
    if (items.some(i => i.kind === 'op'))
        return null;
    return items.map(i => (i.kind === 'word' ? i.text : ''));
}
function commandPrefix(command) {
    const words = plainWords(command);
    if (!words || !words[0])
        return undefined;
    if (SUBCOMMAND_TOOLS.has(words[0]) && words[1] && !words[1].startsWith('-'))
        return `${words[0]} ${words[1]}`;
    return words[0];
}
function matchesPrefix(command, prefix) {
    const words = plainWords(command);
    const want = prefix.trim().split(/\s+/).filter(Boolean);
    if (!words || want.length === 0 || words.length < want.length)
        return false;
    return want.every((w, i) => words[i] === w);
}
class Permissions {
    mode;
    allowedCommands;
    ask;
    sessionEdits = false;
    sessionCommands = new Set();
    constructor(mode, allowedCommands, ask) {
        this.mode = mode;
        this.allowedCommands = allowedCommands;
        this.ask = ask;
    }
    setAsker(ask) { this.ask = ask; }
    async check(req) {
        if (this.mode === 'bypass')
            return { ok: true };
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
        if (req.kind === 'edit' && !req.outsideRoot && (this.mode === 'acceptEdits' || this.mode === 'auto' || this.sessionEdits))
            return { ok: true };
        // Auto mode runs every command the risk rules do not flag; a flagged one
        // falls through to the allowances and then to the person.
        if (req.kind === 'command' && this.mode === 'auto' && !req.risk)
            return { ok: true };
        if (req.kind === 'command' && req.detail) {
            const command = req.detail;
            for (const prefix of [...this.allowedCommands, ...this.sessionCommands]) {
                if (matchesPrefix(command, prefix))
                    return { ok: true };
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
            if (req.kind === 'edit')
                this.sessionEdits = true;
            if (req.kind === 'command' && req.commandPrefix)
                this.sessionCommands.add(req.commandPrefix);
        }
        return { ok: true };
    }
}
exports.Permissions = Permissions;
//# sourceMappingURL=permissions.js.map