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
exports.VERSION = void 0;
exports.makeCompleter = makeCompleter;
exports.runRepl = runRepl;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const client_1 = require("./client");
const config_1 = require("./config");
const input_1 = require("./input");
const prompt_1 = require("./prompt");
const render_1 = require("./render");
const ide_1 = require("./ide");
const ideBridge_1 = require("./ideBridge");
const screen_1 = require("./screen");
const ignore_1 = require("./ignore");
const session_1 = require("./session");
const tools_1 = require("./tools");
const ui_1 = require("./ui");
// Read from package.json (one level above dist/) so a version bump is a one-place edit.
exports.VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
const MODE_LABEL = {
    default: 'default',
    acceptEdits: 'accept edits',
    auto: 'auto',
    plan: 'plan (read-only)',
    bypass: 'bypass permissions',
};
function modeColor(mode, s) {
    return mode === 'plan' ? ui_1.c.cyan(s) : mode === 'acceptEdits' ? ui_1.c.magenta(s) : mode === 'auto' ? ui_1.c.yellow(s) : mode === 'bypass' ? ui_1.c.red(s) : s;
}
function box(lines) {
    const width = Math.min((0, ui_1.columns)() - 2, Math.max(...lines.map(l => (0, ui_1.stripAnsi)(l).length)) + 4);
    const pad = (l) => l + ' '.repeat(Math.max(0, width - 4 - (0, ui_1.stripAnsi)(l).length));
    return [
        ui_1.c.accent(`╭${'─'.repeat(width - 2)}╮`),
        ...lines.map(l => `${ui_1.c.accent('│')} ${pad(l)} ${ui_1.c.accent('│')}`),
        ui_1.c.accent(`╰${'─'.repeat(width - 2)}╯`),
    ].join('\n');
}
// The slash commands: the /help Commands tab and Tab completion both read this.
const COMMANDS = [
    { name: '/help', about: 'this help' },
    { name: '/clear', about: 'start a new conversation' },
    { name: '/compact', args: '[focus]', about: 'summarise the conversation to free context' },
    { name: '/model', args: '[id]', about: 'show or switch the model (no id: pick from a list)' },
    { name: '/models', about: 'list the models the endpoint serves' },
    { name: '/mode', args: '[name]', about: 'permission mode: default · acceptEdits · auto · plan · bypass (no name: cycle)' },
    { name: '/plan', about: 'shortcut for /mode plan' },
    { name: '/init', about: 'write a KEDTEC.md describing this project' },
    { name: '/resume', about: 'reopen an earlier conversation in this directory' },
    { name: '/todos', about: 'show the current checklist' },
    { name: '/cost', about: 'token usage this session' },
    { name: '/status', about: 'endpoint, model, mode, key and instruction files' },
    { name: '/mouse', args: '[on|off]', about: 'mouse-wheel scrolling (off gives plain drag-to-select back)' },
    { name: '/exit', about: 'quit (or ctrl+d)' },
];
const SLASH_COMMANDS = COMMANDS.map(cmd => cmd.name);
const MAX_MENTION_SUGGESTIONS = 50;
// How long the project's file list is reused between @ completions.
const FILE_LIST_TTL_MS = 30_000;
// What the input box offers while typing: the slash commands matching a
// leading "/", and for an "@" the entries of the folder being typed into, then
// (for a bare name) project files whose name or path contains it. Ignored
// files are left out, as the search tools leave them out.
function makeCompleter(root) {
    let files = [];
    let listedAt = 0;
    const projectFiles = () => {
        if (Date.now() - listedAt > FILE_LIST_TTL_MS) {
            files = (0, tools_1.listProjectFiles)(root);
            listedAt = Date.now();
        }
        return files;
    };
    const mentions = (query) => {
        const slash = query.lastIndexOf('/');
        const dirPart = query.slice(0, slash + 1);
        const prefix = query.slice(slash + 1).toLowerCase();
        const out = [];
        const dirAbs = path.resolve(root, dirPart || '.');
        if ((0, tools_1.isInsideRoot)(dirAbs, root)) {
            const matcher = (0, ignore_1.loadIgnoreMatcher)(root);
            let entries = [];
            try {
                entries = fs.readdirSync(dirAbs, { withFileTypes: true });
            }
            catch { /* not a folder (yet) */ }
            for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                if (e.name === '.git' || !e.name.toLowerCase().startsWith(prefix))
                    continue;
                const rel = path.relative(root, path.join(dirAbs, e.name)).split(path.sep).join('/');
                if (matcher.isIgnored(rel, e.isDirectory()))
                    continue;
                out.push(`${dirPart}${e.name}${e.isDirectory() ? '/' : ''}`);
            }
        }
        if (prefix && !dirPart) {
            const all = projectFiles();
            const byName = all.filter(f => path.posix.basename(f).toLowerCase().includes(prefix));
            const byPath = all.filter(f => f.toLowerCase().includes(prefix));
            for (const f of [...byName, ...byPath]) {
                if (out.length >= MAX_MENTION_SUGGESTIONS)
                    break;
                if (!out.includes(f))
                    out.push(f);
            }
        }
        return out.slice(0, MAX_MENTION_SUGGESTIONS);
    };
    return (text, cursor) => {
        if (/^\/\S*$/.test(text)) {
            const typed = text.toLowerCase();
            const items = COMMANDS.filter(cmd => cmd.name.startsWith(typed)).map(cmd => ({
                label: cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name, detail: cmd.about, value: `${cmd.name} `, submit: true,
            }));
            return items.length ? { items, start: 0, end: text.length } : null;
        }
        const at = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
        if (!at)
            return null;
        const start = cursor - at[1].length - 1;
        let end = cursor;
        while (end < text.length && !/\s/.test(text[end]))
            end++;
        // A folder stays open for the next level; a file ends the mention.
        const items = mentions(at[1]).map(p => ({ label: p, value: p.endsWith('/') ? `@${p}` : `@${p} ` }));
        return items.length ? { items, start, end } : null;
    };
}
const HELP_URL = 'https://github.com/sovannDeveloper/kedtec-cli#readme';
// The /help panel's tabs. The scrolling keys exist only in the full-screen view.
function helpTabs(fullScreen) {
    const general = {
        name: 'General',
        body: width => [
            ...(0, ui_1.wrapText)('KEDTec understands your codebase, makes edits with your permission, and runs commands — right from your terminal.', width).split('\n'),
            ui_1.c.bold('Shortcuts'),
            ...(0, ui_1.columnLayout)([
                ['! for shell mode', '/ for commands', '@ for file paths', '\\ at line end for newline'],
                ['esc to clear input', 'esc to interrupt KEDTec', 'shift + tab to cycle modes', 'ctrl + j for newline', 'tab to complete / and @'],
                [
                    '↑ / ↓ for history',
                    ...(fullScreen ? ['pgup / pgdn to scroll', 'shift + ↑ / ↓ to scroll a line', 'ctrl + l to clear the screen'] : []),
                    'ctrl + c twice to exit',
                ],
            ], width),
            '',
            ...(width >= 16 + HELP_URL.length ? [`For more help: ${ui_1.c.cyan(HELP_URL)}`] : ['For more help:', ui_1.c.cyan(HELP_URL)]),
        ],
    };
    const commands = {
        name: 'Commands',
        body: width => {
            const label = (cmd) => (cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name);
            const col = Math.max(...COMMANDS.map(cmd => label(cmd).length)) + 3;
            return COMMANDS.map(cmd => {
                const about = width - col > 10 ? (0, ui_1.clip)(cmd.about, width - col) : '';
                return `${ui_1.c.bold(cmd.name)}${cmd.args ? ` ${ui_1.c.gray(cmd.args)}` : ''}${' '.repeat(col - label(cmd).length)}${ui_1.c.gray(about)}`.trimEnd();
            });
        },
    };
    return [general, commands];
}
const INIT_PROMPT = `Analyse this codebase and write a KEDTEC.md file at the project root for future agent sessions.
Include: what the project is; the commands to install, build, run, lint and test (and how to run a single test); the high-level architecture and how the main pieces fit together, which needs several files read to understand; and the conventions and gotchas a newcomer would not guess.
Do not list every file or repeat what is obvious from the tree, and do not invent anything you have not seen. If a KEDTEC.md, CLAUDE.md or AGENTS.md already exists, improve it instead of starting over. Read README files and manifests first.`;
const MAX_MENTION_BYTES = 200 * 1024;
// "@src/app.ts" → the file's text, attached to the message. Only files inside
// the project, and the read counts as a read for the edit guard.
function expandMentions(text, root, agent) {
    const attached = [];
    const blocks = [];
    for (const m of text.matchAll(/(^|\s)@([^\s@]+)/g)) {
        const raw = m[2].replace(/[.,;:!?)]+$/, '');
        const abs = path.resolve(root, raw);
        if (!(0, tools_1.isInsideRoot)(abs, root) || attached.includes(abs))
            continue;
        try {
            const st = fs.statSync(abs);
            if (!st.isFile() || st.size > MAX_MENTION_BYTES)
                continue;
            const body = fs.readFileSync(abs, 'utf8');
            if (body.includes('\u0000'))
                continue;
            const numbered = body.split('\n').map((l, i) => `${i + 1}|${l}`).join('\n');
            blocks.push(`<file path="${(0, tools_1.displayPath)(abs, root)}">\n${numbered}\n</file>`);
            attached.push(abs);
            agent.readState.set(abs, st.mtimeMs);
        }
        catch { /* not a file: leave the text alone */ }
    }
    if (blocks.length === 0)
        return { text, attached };
    return { text: `${text}\n\nAttached files (line-numbered as read_file returns them):\n\n${blocks.join('\n\n')}`, attached };
}
async function runRepl(opts) {
    const { agent, permissions, root } = opts;
    // Name the tab "✳ KEDTec" rather than "node", and give it back on every way
    // out — /exit, ctrl+c twice, a crash — so the shell's tab is not left wearing it.
    process.title = 'kedtec';
    (0, ui_1.setTerminalTitle)(ui_1.TERMINAL_TITLE);
    process.on('exit', () => (0, ui_1.setTerminalTitle)(''));
    // On a capable terminal the input box and status line are pinned to the
    // bottom (screen.ts); otherwise a plain readline prompt follows the output.
    const screen = new screen_1.Screen();
    const input = screen_1.Screen.supported() ? screen : new input_1.LineInput();
    screen.completions = SLASH_COMMANDS;
    screen.completer = makeCompleter(root);
    // Usage is known once a round's stream ends; the bar's context figure follows
    // it. With the pinned layout the spinner draws in the row above the input box.
    const renderer = new render_1.TerminalRenderer(process.stdout, {
        showText: true, showReasoning: false, spinner: true, onRoundEnd: () => refreshBar(),
        activity: screen_1.Screen.supported() ? line => screen.setActivity(line) : undefined,
    });
    let current = null;
    let lastInterrupt = 0;
    let session = opts.session;
    const keys = new input_1.TurnKeys(() => {
        if (current && !current.signal.aborted) {
            renderer.spinner.stop();
            process.stdout.write(`\n${ui_1.c.yellow('⎿  Interrupted')} ${ui_1.c.gray('— what should KEDTec do instead?')}\n`);
            current.abort();
        }
    }, () => cycleMode(), direction => screen.scrollBy(direction * 10));
    // shift+tab cycles default → accept edits → auto → plan; bypass joins the
    // cycle only when the session was started in it, so a stray keypress never reaches it.
    const cycle = permissions.mode === 'bypass'
        ? ['default', 'acceptEdits', 'auto', 'plan', 'bypass'] : ['default', 'acceptEdits', 'auto', 'plan'];
    const setMode = (mode) => {
        permissions.mode = mode;
        rememberMode(mode);
        refreshBar();
    };
    const cycleMode = () => setMode(cycle[(cycle.indexOf(permissions.mode) + 1) % cycle.length]);
    screen.onShiftTab = cycleMode;
    // An approval has to be seen: bring the view back to the bottom for it.
    const asker = req => keys.suspend(() => { screen.scrollToBottom(); return askPermission(req, renderer, input); });
    permissions.setAsker(asker);
    // The file open (and lines selected) in the VS Code window this terminal
    // belongs to, via the KEDTec extension: shown on the status line, and handed
    // to the model with the next message.
    const ide = new ide_1.IdeWatcher(root, () => refreshBar());
    const ideContext = new ide_1.IdeContext(root);
    // The pinned status line, under the input box: the permission mode on the
    // left (as Claude Code shows it), the model and context use on the right.
    const refreshBar = () => {
        const mode = permissions.mode;
        const used = agent.lastPromptTokens;
        const cw = agent.opts.contextWindow;
        const ctx = used ? `${formatTokens(used)}${cw ? ` / ${formatTokens(cw)} (${Math.round((used / cw) * 100)}%)` : ''} ctx` : '';
        const hint = ui_1.c.gray(' (shift+tab to cycle)');
        const left = mode === 'acceptEdits' ? `${ui_1.c.magenta('⏵⏵ accept edits on')}${hint}`
            : mode === 'auto' ? `${ui_1.c.yellow('⏵⏵ auto mode on')}${hint}`
                : mode === 'plan' ? `${ui_1.c.cyan('⏸ plan mode on')}${hint}`
                    : mode === 'bypass' ? `${ui_1.c.red('⏵⏵ bypass permissions on')}${hint}`
                        : ui_1.c.gray('? /help for commands · shift+tab to cycle modes');
        const inIde = (0, ide_1.ideLabel)(ide.state);
        const right = [inIde ? ui_1.c.blue(inIde) : '', `${ui_1.c.accent('●')} ${agent.opts.model}`, ctx ? ui_1.c.gray(ctx) : ''];
        screen.setStatus(left, right);
    };
    process.on('SIGINT', () => {
        if (current && !current.signal.aborted)
            current.abort();
        else {
            process.stdout.write('\n');
            process.exit(130);
        }
    });
    const banner = () => {
        const model = agent.opts.model;
        console.log(box([
            `${ui_1.c.accent('✻')} ${ui_1.c.bold('KEDTec CLI')} ${ui_1.c.gray(`v${exports.VERSION}`)}`,
            '',
            `${ui_1.c.gray('model')}  ${model}`,
            `${ui_1.c.gray('mode ')}  ${modeColor(permissions.mode, MODE_LABEL[permissions.mode])}`,
            `${ui_1.c.gray('cwd  ')}  ${(0, ui_1.clip)(root, 60)}`,
        ]));
        const instr = (0, prompt_1.loadInstructions)(root, opts.projectConfig).map(f => (0, tools_1.displayPath)(f.path, root));
        if (instr.length)
            console.log(ui_1.c.gray(`  instructions: ${instr.join(', ')}`));
        console.log(ui_1.c.gray('  /help for commands · ! runs a shell command · @file attaches a file · esc interrupts\n'));
    };
    const persist = () => {
        session.messages = agent.messages;
        session.usage = agent.usage;
        session.model = agent.opts.model;
        (0, session_1.saveSession)(session);
    };
    const send = async (text) => {
        const { text: mentioned, attached } = expandMentions(text, root, agent);
        const fromIde = ideContext.forMessage(ide.state);
        const expanded = fromIde ? `${mentioned}\n\n${fromIde.text}` : mentioned;
        if (fromIde?.note)
            console.log(ui_1.c.gray(`  ${fromIde.note}`));
        if (attached.length)
            console.log(ui_1.c.gray(`  ⎿  attached ${attached.map(a => (0, tools_1.displayPath)(a, root)).join(', ')}`));
        if (!session.title || session.title === '(untitled)')
            session.title = (0, session_1.titleFrom)(text);
        current = new AbortController();
        renderer.beginTurn();
        renderer.thinking();
        keys.start();
        let done = '';
        try {
            const result = await agent.run(expanded, renderer, current.signal);
            if (result.error)
                console.log(`\n${ui_1.c.red('✗')} ${result.error}`);
            // "✻ Baked for 9s" under a finished answer; an interrupted turn has
            // already said so.
            if (!result.stopped)
                done = renderer.endTurn();
        }
        finally {
            keys.stop();
            renderer.endTurn();
            current = null;
            refreshBar();
            persist();
        }
        if (done)
            console.log(`\n${done}`);
        // With the pinned box, the echo of the next message supplies the spacing.
        if (!screen.enabled)
            console.log();
    };
    const command = async (line) => {
        const [cmd, ...rest] = line.slice(1).split(/\s+/);
        const arg = rest.join(' ').trim();
        switch (cmd) {
            case 'help':
            case '?':
                await (0, input_1.tabbedPanel)('Help', helpTabs(screen.enabled));
                console.log(ui_1.c.gray('  ⎿  Help dialog dismissed'));
                return true;
            case 'exit':
            case 'quit':
            case 'q':
                return false;
            case 'clear':
            case 'new':
                persist();
                agent.clear();
                session = { ...session, id: (0, session_1.newSessionId)(), title: '', created: new Date().toISOString(), messages: [], usage: { prompt: 0, completion: 0 } };
                screen.clearTranscript();
                banner();
                refreshBar();
                return true;
            case 'compact': {
                if (agent.messages.length === 0) {
                    console.log(ui_1.c.gray('  Nothing to compact.'));
                    return true;
                }
                renderer.spinner.start('Compacting conversation…');
                current = new AbortController();
                keys.start();
                try {
                    await agent.compact(current.signal, arg || undefined);
                    renderer.spinner.stop();
                    console.log(ui_1.c.gray('  ⎿  Conversation compacted. The summary replaces the history from here on.'));
                    refreshBar();
                    persist();
                }
                catch (err) {
                    renderer.spinner.stop();
                    console.log(ui_1.c.red(`  ✗ ${(0, client_1.describeError)(err)}`));
                }
                finally {
                    keys.stop();
                    current = null;
                }
                return true;
            }
            case 'model': {
                if (arg) {
                    const found = opts.models.find(m => m.id === arg);
                    opts.setModel(found ?? arg);
                    refreshBar();
                    console.log(ui_1.c.gray(`  ⎿  Model: ${agent.opts.model}${found ? '' : ' (not in the endpoint\'s list — using it as typed)'}`));
                    return true;
                }
                if (opts.models.length === 0) {
                    console.log(ui_1.c.gray(`  Model: ${agent.opts.model}`));
                    return true;
                }
                const choice = await (0, input_1.select)(opts.models.map(m => (m.name !== m.id ? `${m.id} ${ui_1.c.gray(m.name)}` : m.id)), Math.max(0, opts.models.findIndex(m => m.id === agent.opts.model)), { title: ui_1.c.gray('  Choose a model (enter selects, esc cancels):'), transient: true });
                if (choice === null)
                    console.log(ui_1.c.gray(`  ⎿  Model: ${agent.opts.model} (unchanged)`));
                else {
                    opts.setModel(opts.models[choice]);
                    refreshBar();
                    const save = (0, config_1.readStoredConfig)();
                    save.model = agent.opts.model;
                    (0, config_1.writeStoredConfig)(save);
                    console.log(ui_1.c.gray(`  ⎿  Model: ${agent.opts.model} (saved as default)`));
                }
                return true;
            }
            case 'models':
                try {
                    const models = await (0, client_1.listModels)(opts.config.endpoint, opts.config.apiKey);
                    opts.models.splice(0, opts.models.length, ...models);
                    for (const m of models)
                        console.log(`  ${m.id === agent.opts.model ? ui_1.c.accent('●') : ' '} ${m.id}${m.name !== m.id ? ui_1.c.gray(`  ${m.name}`) : ''}`);
                }
                catch (err) {
                    console.log(ui_1.c.red(`  ✗ ${(0, client_1.describeError)(err)}`));
                }
                return true;
            case 'mode':
            case 'plan': {
                const target = cmd === 'plan' ? 'plan' : arg ? (0, config_1.normalizeMode)(arg) : cycle[(cycle.indexOf(permissions.mode) + 1) % cycle.length];
                if (!target) {
                    console.log(ui_1.c.red(`  Unknown mode "${arg}". One of: ${config_1.PERMISSION_MODES.join(', ')}`));
                    return true;
                }
                setMode(target);
                console.log(`  ${ui_1.c.gray('⎿  Mode:')} ${modeColor(target, MODE_LABEL[target])}`);
                return true;
            }
            case 'mouse': {
                if (!screen.enabled) {
                    console.log(ui_1.c.gray('  The mouse is only captured in the full-screen view.'));
                    return true;
                }
                const on = arg === 'on' ? true : arg === 'off' ? false : !screen.mouseEnabled;
                screen.setMouse(on);
                console.log(ui_1.c.gray(on
                    ? '  ⎿  Mouse on: the wheel scrolls the conversation. Hold Shift (Option on a Mac) to select text.'
                    : '  ⎿  Mouse off: drag selects text again; PgUp/PgDn scroll the conversation.'));
                return true;
            }
            case 'init':
                await send(INIT_PROMPT);
                return true;
            case 'resume': {
                const sessions = (0, session_1.listSessions)(root).filter(s => s.id !== session.id).slice(0, 15);
                if (sessions.length === 0) {
                    console.log(ui_1.c.gray('  No earlier conversations in this directory.'));
                    return true;
                }
                const choice = await (0, input_1.select)(sessions.map(s => `${(0, ui_1.clip)(s.title || '(untitled)', 50)} ${ui_1.c.gray(`${s.updated.slice(0, 16).replace('T', ' ')} · ${s.messages.length} msgs`)}`), 0, { title: ui_1.c.gray('  Resume a conversation (enter selects, esc cancels):'), transient: true });
                if (choice !== null) {
                    persist();
                    session = sessions[choice];
                    agent.clear();
                    agent.messages = session.messages;
                    agent.usage = session.usage ?? { prompt: 0, completion: 0 };
                    console.log(ui_1.c.gray(`  ⎿  Resumed "${session.title}". Files must be re-read before they are edited.`));
                    refreshBar();
                }
                return true;
            }
            case 'todos':
                if (agent.todos.length === 0)
                    console.log(ui_1.c.gray('  No todos.'));
                for (const t of agent.todos)
                    console.log(`  ${t.status === 'completed' ? ui_1.c.green('☒') : t.status === 'in_progress' ? ui_1.c.yellow('◼') : '☐'} ${t.content}`);
                return true;
            case 'cost':
            case 'usage':
                console.log(`  ${ui_1.c.gray('input tokens ')} ${agent.usage.prompt.toLocaleString()}\n  ${ui_1.c.gray('output tokens')} ${agent.usage.completion.toLocaleString()}\n  ${ui_1.c.gray('last request ')} ${agent.lastPromptTokens.toLocaleString()} tokens of context${agent.opts.contextWindow ? ` / ${agent.opts.contextWindow.toLocaleString()}` : ''}`);
                return true;
            case 'status': {
                const instr = (0, prompt_1.loadInstructions)(root, opts.projectConfig);
                console.log([
                    `  ${ui_1.c.gray('endpoint')}  ${opts.config.endpoint}`,
                    `  ${ui_1.c.gray('api key ')}  ${(0, config_1.maskKey)(opts.config.apiKey)}`,
                    `  ${ui_1.c.gray('model   ')}  ${agent.opts.model}`,
                    `  ${ui_1.c.gray('mode    ')}  ${modeColor(permissions.mode, MODE_LABEL[permissions.mode])}`,
                    `  ${ui_1.c.gray('root    ')}  ${root}`,
                    `  ${ui_1.c.gray('session ')}  ${session.id}`,
                    `  ${ui_1.c.gray('instructions')} ${instr.length ? instr.map(f => `${(0, tools_1.displayPath)(f.path, root)}${!f.truncated ? '' : f.text ? ' (truncated)' : ' (omitted)'}`).join(', ') : 'none'}`,
                ].join('\n'));
                return true;
            }
            default:
                console.log(ui_1.c.red(`  Unknown command /${cmd}. /help lists them.`));
                return true;
        }
    };
    await screen.enable();
    ide.start();
    banner();
    refreshBar();
    // No window reports this project yet: put the bridge extension into the editor.
    if (!ide.state) {
        void (0, ideBridge_1.ensureIdeBridge)().then(result => {
            if (result === 'installed' || result === 'updated') {
                console.log(ui_1.c.gray(`  ⧉ ${result === 'installed' ? 'Installed' : 'Updated'} the KEDTec CLI Bridge in VS Code, so your open file and selection show here.`));
                console.log(ui_1.c.gray('    If they do not appear in a few seconds, run "Developer: Reload Window".\n'));
            }
            else if (result === 'failed') {
                console.log(ui_1.c.gray('  ⧉ Could not install the KEDTec CLI Bridge in VS Code; the open file and selection will not show here.\n'));
            }
        });
    }
    if (agent.messages.length > 0)
        console.log(ui_1.c.gray(`  Continuing "${session.title}" (${agent.messages.length} messages).\n`));
    if (opts.initialPrompt) {
        console.log(`${ui_1.c.gray('>')} ${opts.initialPrompt}`);
        await send(opts.initialPrompt);
    }
    for (;;) {
        // The pinned layout shows the mode under the box; the plain prompt has to
        // carry it itself.
        const mode = permissions.mode;
        const prefix = screen.enabled || mode === 'default' ? '' : `${modeColor(mode, mode === 'acceptEdits' ? 'accept-edits' : mode)} `;
        const answer = await input.ask(screen.enabled ? `${ui_1.c.bold('❯')} ` : `${prefix}${ui_1.c.accent('>')} `, {
            placeholder: agent.messages.length === 0 ? 'Try "explain how this project is structured"' : 'Ask KEDTec anything',
        });
        if (answer.kind === 'eof')
            break;
        if (answer.kind === 'interrupt') {
            if (Date.now() - lastInterrupt < 1500)
                break;
            lastInterrupt = Date.now();
            console.log(ui_1.c.gray('  (press ctrl+c again to exit)'));
            continue;
        }
        const text = answer.text.trim();
        if (!text)
            continue;
        // The box empties on submit, so the message is written into the transcript.
        if (screen.enabled)
            echo(text);
        if (text.startsWith('/') && !text.startsWith('//')) {
            if (!(await command(text)))
                break;
            continue;
        }
        if (text.startsWith('!')) {
            const cmd = text.slice(1).trim();
            if (!cmd)
                continue;
            current = new AbortController();
            keys.start();
            const res = await (0, tools_1.runShell)(cmd, root, 600_000, current.signal);
            keys.stop();
            current = null;
            const out = res.output.trimEnd();
            if (out)
                console.log(out.split('\n').map(l => `  ${l}`).join('\n'));
            console.log(ui_1.c.gray(`  ⎿  exit ${res.code}`));
            agent.messages.push({ role: 'user', content: `I ran this shell command myself:\n$ ${cmd}\n\`\`\`\n${out.length > 20000 ? out.slice(-20000) : out}\n\`\`\`\n(exit ${res.code})` });
            agent.messages.push({ role: 'assistant', content: 'Noted.' });
            persist();
            continue;
        }
        await send(text.startsWith('//') ? text.slice(1) : text);
    }
    persist();
    ide.stop();
    screen.disable();
    console.log(ui_1.c.gray(`\nSession saved — resume with: kedtec --continue`));
    process.exit(0);
}
// The mode picked last becomes the default for the next session — except
// bypass, which has to be asked for each time (--dangerously-skip-permissions):
// a session that silently starts with every prompt skipped is not one anybody
// chose. A flag or KEDTEC_PERMISSION_MODE still wins over what is saved here.
function rememberMode(mode) {
    if (mode === 'bypass')
        return;
    try {
        const stored = (0, config_1.readStoredConfig)();
        if (stored.permissionMode === mode)
            return;
        (0, config_1.writeStoredConfig)({ ...stored, permissionMode: mode });
    }
    catch { /* remembering is a convenience */ }
}
function echo(text) {
    const lines = text.split('\n');
    console.log(`\n${ui_1.c.gray('>')} ${lines[0]}${lines.slice(1).map(l => `\n  ${l}`).join('')}`);
}
function formatTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}
async function askPermission(req, renderer, input) {
    renderer.spinner.stop();
    const width = Math.min((0, ui_1.columns)() - 2, 100);
    console.log(ui_1.c.yellow(`  ${'─'.repeat(width - 2)}`));
    console.log(`  ${ui_1.c.bold(ui_1.c.yellow(req.kind === 'command' ? 'Run this command?' : req.title))}`);
    if (req.detail) {
        if (req.kind === 'edit') {
            const lines = req.detail.split('\n');
            const shown = lines.slice(0, 80).join('\n');
            console.log((0, ui_1.colorDiff)(shown));
            if (lines.length > 80)
                console.log(ui_1.c.gray(`    … ${lines.length - 80} more diff lines`));
        }
        else {
            console.log(req.detail.split('\n').slice(0, 30).map(l => `    ${ui_1.c.cyan(l)}`).join('\n'));
        }
    }
    for (const w of req.warnings ?? [])
        console.log(`  ${ui_1.c.yellow('⚠')} ${w}`);
    const always = req.kind === 'edit' && !req.outsideRoot
        ? 'Yes, and allow all edits this session'
        : req.kind === 'command' && req.commandPrefix
            ? `Yes, and don't ask again for ${ui_1.c.bold(req.commandPrefix)} commands this session`
            : undefined;
    const options = ['Yes', ...(always ? [always] : []), 'No, and tell KEDTec what to do differently (esc)'];
    if (req.kind === 'edit')
        console.log(`  ${ui_1.c.gray('Apply this change?')}`);
    const choice = await (0, input_1.select)(options);
    const noIndex = options.length - 1;
    if (choice === 0)
        return { allow: true };
    if (always && choice === 1)
        return { allow: true, always: true };
    const fb = choice === noIndex || choice === null
        ? await input.ask(`  ${ui_1.c.gray('↳ instead (enter to just decline):')} `, { history: false, multiline: false })
        : { kind: 'eof' };
    return { allow: false, feedback: fb.kind === 'line' ? fb.text : undefined };
}
//# sourceMappingURL=repl.js.map