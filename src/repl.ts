import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { Agent } from './agent';
import { ModelInfo, describeError, listModels } from './client';
import { PERMISSION_MODES, PermissionMode, ResolvedConfig, maskKey, normalizeMode, readStoredConfig, writeStoredConfig } from './config';
import { LineInput, Prompter, TurnKeys, select } from './input';
import { Asker, PermissionRequest, Permissions } from './permissions';
import { loadInstructions } from './prompt';
import { TerminalRenderer } from './render';
import { IdeContext, IdeWatcher, ideLabel } from './ide';
import { ensureIdeBridge } from './ideBridge';
import { Screen } from './screen';
import { SessionFile, listSessions, newSessionId, saveSession, titleFrom } from './session';
import { displayPath, isInsideRoot, runShell } from './tools';
import { TERMINAL_TITLE, c, clip, colorDiff, columns, setTerminalTitle, stripAnsi } from './ui';

// Read from package.json (one level above dist/) so a version bump is a one-place edit.
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

export interface ReplOptions {
  config: ResolvedConfig;
  client: OpenAI;
  root: string;
  models: ModelInfo[];
  agent: Agent;
  permissions: Permissions;
  session: SessionFile;
  initialPrompt?: string;
  setModel(model: ModelInfo | string): void;
}

const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'default',
  acceptEdits: 'accept edits',
  auto: 'auto',
  plan: 'plan (read-only)',
  bypass: 'bypass permissions',
};

function modeColor(mode: PermissionMode, s: string): string {
  return mode === 'plan' ? c.cyan(s) : mode === 'acceptEdits' ? c.magenta(s) : mode === 'auto' ? c.yellow(s) : mode === 'bypass' ? c.red(s) : s;
}

function box(lines: string[]): string {
  const width = Math.min(columns() - 2, Math.max(...lines.map(l => stripAnsi(l).length)) + 4);
  const pad = (l: string) => l + ' '.repeat(Math.max(0, width - 4 - stripAnsi(l).length));
  return [
    c.accent(`╭${'─'.repeat(width - 2)}╮`),
    ...lines.map(l => `${c.accent('│')} ${pad(l)} ${c.accent('│')}`),
    c.accent(`╰${'─'.repeat(width - 2)}╯`),
  ].join('\n');
}

const HELP = `
${c.bold('Commands')}
  /help               this list
  /clear              start a new conversation
  /compact [focus]    summarise the conversation to free context
  /model [id]         show or switch the model (no id: pick from a list)
  /models             list the models the endpoint serves
  /mode [name]        permission mode: default · acceptEdits · auto · plan · bypass (no name: cycle)
  /plan               shortcut for /mode plan
  /init               write a KEDTEC.md describing this project
  /resume             reopen an earlier conversation in this directory
  /todos              show the current checklist
  /cost               token usage this session
  /status             endpoint, model, mode, key and instruction files
  /mouse [on|off]     mouse-wheel scrolling (off gives plain drag-to-select back)
  /exit               quit (or ctrl+d)

${c.bold('Input')}
  !command            run a shell command yourself; its output goes into the conversation
  @path/to/file       attach a file's contents to the message
  line ending in \\    continue on the next line (pasting several lines also works)
  esc / ctrl+c        interrupt the agent · ctrl+c twice at the prompt quits
  wheel · PgUp/PgDn   scroll the conversation (shift+↑/↓ one line); the input stays put
`;

const INIT_PROMPT = `Analyse this codebase and write a KEDTEC.md file at the project root for future agent sessions.
Include: what the project is; the commands to install, build, run, lint and test (and how to run a single test); the high-level architecture and how the main pieces fit together, which needs several files read to understand; and the conventions and gotchas a newcomer would not guess.
Do not list every file or repeat what is obvious from the tree, and do not invent anything you have not seen. If a KEDTEC.md, CLAUDE.md or AGENTS.md already exists, improve it instead of starting over. Read README files and manifests first.`;

const MAX_MENTION_BYTES = 200 * 1024;

// "@src/app.ts" → the file's text, attached to the message. Only files inside
// the project, and the read counts as a read for the edit guard.
function expandMentions(text: string, root: string, agent: Agent): { text: string; attached: string[] } {
  const attached: string[] = [];
  const blocks: string[] = [];
  for (const m of text.matchAll(/(^|\s)@([^\s@]+)/g)) {
    const raw = m[2].replace(/[.,;:!?)]+$/, '');
    const abs = path.resolve(root, raw);
    if (!isInsideRoot(abs, root) || attached.includes(abs)) continue;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_MENTION_BYTES) continue;
      const body = fs.readFileSync(abs, 'utf8');
      if (body.includes('\u0000')) continue;
      const numbered = body.split('\n').map((l, i) => `${i + 1}|${l}`).join('\n');
      blocks.push(`<file path="${displayPath(abs, root)}">\n${numbered}\n</file>`);
      attached.push(abs);
      agent.readState.set(abs, st.mtimeMs);
    } catch { /* not a file: leave the text alone */ }
  }
  if (blocks.length === 0) return { text, attached };
  return { text: `${text}\n\nAttached files (line-numbered as read_file returns them):\n\n${blocks.join('\n\n')}`, attached };
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const { agent, permissions, root } = opts;
  // Name the tab "✳ KEDTec" rather than "node", and give it back on every way
  // out — /exit, ctrl+c twice, a crash — so the shell's tab is not left wearing it.
  process.title = 'kedtec';
  setTerminalTitle(TERMINAL_TITLE);
  process.on('exit', () => setTerminalTitle(''));
  // On a capable terminal the input box and status line are pinned to the
  // bottom (screen.ts); otherwise a plain readline prompt follows the output.
  const screen = new Screen();
  const input: Prompter = Screen.supported() ? screen : new LineInput();
  screen.completions = SLASH_COMMANDS;
  // Usage is known once a round's stream ends; the bar's context figure follows
  // it. With the pinned layout the spinner draws in the row above the input box.
  const renderer = new TerminalRenderer(process.stdout, {
    showText: true, showReasoning: false, spinner: true, onRoundEnd: () => refreshBar(),
    activity: Screen.supported() ? line => screen.setActivity(line) : undefined,
  });
  let current: AbortController | null = null;
  let lastInterrupt = 0;
  let session = opts.session;

  const keys = new TurnKeys(() => {
    if (current && !current.signal.aborted) {
      renderer.spinner.stop();
      process.stdout.write(`\n${c.yellow('⎿  Interrupted')} ${c.gray('— what should KEDTec do instead?')}\n`);
      current.abort();
    }
  }, () => cycleMode(), direction => screen.scrollBy(direction * 10));

  // shift+tab cycles default → accept edits → auto → plan; bypass joins the
  // cycle only when the session was started in it, so a stray keypress never reaches it.
  const cycle: PermissionMode[] = permissions.mode === 'bypass'
    ? ['default', 'acceptEdits', 'auto', 'plan', 'bypass'] : ['default', 'acceptEdits', 'auto', 'plan'];
  const setMode = (mode: PermissionMode) => {
    permissions.mode = mode;
    rememberMode(mode);
    refreshBar();
  };
  const cycleMode = () => setMode(cycle[(cycle.indexOf(permissions.mode) + 1) % cycle.length]);
  screen.onShiftTab = cycleMode;

  // An approval has to be seen: bring the view back to the bottom for it.
  const asker: Asker = req => keys.suspend(() => { screen.scrollToBottom(); return askPermission(req, renderer, input); });
  permissions.setAsker(asker);

  // The file open (and lines selected) in the VS Code window this terminal
  // belongs to, via the KEDTec extension: shown on the status line, and handed
  // to the model with the next message.
  const ide = new IdeWatcher(root, () => refreshBar());
  const ideContext = new IdeContext(root);

  // The pinned status line, under the input box: the permission mode on the
  // left (as Claude Code shows it), the model and context use on the right.
  const refreshBar = () => {
    const mode = permissions.mode;
    const used = agent.lastPromptTokens;
    const cw = agent.opts.contextWindow;
    const ctx = used ? `${formatTokens(used)}${cw ? ` / ${formatTokens(cw)} (${Math.round((used / cw) * 100)}%)` : ''} ctx` : '';
    const hint = c.gray(' (shift+tab to cycle)');
    const left = mode === 'acceptEdits' ? `${c.magenta('⏵⏵ accept edits on')}${hint}`
      : mode === 'auto' ? `${c.yellow('⏵⏵ auto mode on')}${hint}`
      : mode === 'plan' ? `${c.cyan('⏸ plan mode on')}${hint}`
        : mode === 'bypass' ? `${c.red('⏵⏵ bypass permissions on')}${hint}`
          : c.gray('? /help for commands · shift+tab to cycle modes');
    const inIde = ideLabel(ide.state);
    const right = [inIde ? c.blue(inIde) : '', `${c.accent('●')} ${agent.opts.model}`, ctx ? c.gray(ctx) : ''];
    screen.setStatus(left, right);
  };

  process.on('SIGINT', () => {
    if (current && !current.signal.aborted) current.abort();
    else { process.stdout.write('\n'); process.exit(130); }
  });

  const banner = () => {
    const model = agent.opts.model;
    console.log(box([
      `${c.accent('✻')} ${c.bold('KEDTec CLI')} ${c.gray(`v${VERSION}`)}`,
      '',
      `${c.gray('model')}  ${model}`,
      `${c.gray('mode ')}  ${modeColor(permissions.mode, MODE_LABEL[permissions.mode])}`,
      `${c.gray('cwd  ')}  ${clip(root, 60)}`,
    ]));
    const instr = loadInstructions(root).map(f => displayPath(f.path, root));
    if (instr.length) console.log(c.gray(`  instructions: ${instr.join(', ')}`));
    console.log(c.gray('  /help for commands · ! runs a shell command · @file attaches a file · esc interrupts\n'));
  };

  const persist = () => {
    session.messages = agent.messages;
    session.usage = agent.usage;
    session.model = agent.opts.model;
    saveSession(session);
  };

  const send = async (text: string) => {
    const { text: mentioned, attached } = expandMentions(text, root, agent);
    const fromIde = ideContext.forMessage(ide.state);
    const expanded = fromIde ? `${mentioned}\n\n${fromIde.text}` : mentioned;
    if (fromIde?.note) console.log(c.gray(`  ${fromIde.note}`));
    if (attached.length) console.log(c.gray(`  ⎿  attached ${attached.map(a => displayPath(a, root)).join(', ')}`));
    if (!session.title || session.title === '(untitled)') session.title = titleFrom(text);
    current = new AbortController();
    renderer.beginTurn();
    renderer.thinking();
    keys.start();
    let done = '';
    try {
      const result = await agent.run(expanded, renderer, current.signal);
      if (result.error) console.log(`\n${c.red('✗')} ${result.error}`);
      // "✻ Baked for 9s" under a finished answer; an interrupted turn has
      // already said so.
      if (!result.stopped) done = renderer.endTurn();
    } finally {
      keys.stop();
      renderer.endTurn();
      current = null;
      refreshBar();
      persist();
    }
    if (done) console.log(`\n${done}`);
    // With the pinned box, the echo of the next message supplies the spacing.
    if (!screen.enabled) console.log();
  };

  const command = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'help': case '?':
        console.log(HELP);
        return true;
      case 'exit': case 'quit': case 'q':
        return false;
      case 'clear': case 'new':
        persist();
        agent.clear();
        session = { ...session, id: newSessionId(), title: '', created: new Date().toISOString(), messages: [], usage: { prompt: 0, completion: 0 } };
        screen.clearTranscript();
        banner();
        refreshBar();
        return true;
      case 'compact': {
        if (agent.messages.length === 0) { console.log(c.gray('  Nothing to compact.')); return true; }
        renderer.spinner.start('Compacting conversation…');
        current = new AbortController();
        keys.start();
        try {
          await agent.compact(current.signal, arg || undefined);
          renderer.spinner.stop();
          console.log(c.gray('  ⎿  Conversation compacted. The summary replaces the history from here on.'));
          refreshBar();
          persist();
        } catch (err) {
          renderer.spinner.stop();
          console.log(c.red(`  ✗ ${describeError(err)}`));
        } finally { keys.stop(); current = null; }
        return true;
      }
      case 'model': {
        if (arg) {
          const found = opts.models.find(m => m.id === arg);
          opts.setModel(found ?? arg);
          refreshBar();
          console.log(c.gray(`  ⎿  Model: ${agent.opts.model}${found ? '' : ' (not in the endpoint\'s list — using it as typed)'}`));
          return true;
        }
        if (opts.models.length === 0) { console.log(c.gray(`  Model: ${agent.opts.model}`)); return true; }
        console.log(c.gray('  Choose a model (enter selects, esc cancels):'));
        const choice = await select(opts.models.map(m => (m.name !== m.id ? `${m.id} ${c.gray(m.name)}` : m.id)),
          Math.max(0, opts.models.findIndex(m => m.id === agent.opts.model)));
        if (choice !== null) {
          opts.setModel(opts.models[choice]);
          refreshBar();
          const save = readStoredConfig();
          save.model = agent.opts.model;
          writeStoredConfig(save);
          console.log(c.gray(`  ⎿  Model: ${agent.opts.model} (saved as default)`));
        }
        return true;
      }
      case 'models':
        try {
          const models = await listModels(opts.config.endpoint, opts.config.apiKey);
          opts.models.splice(0, opts.models.length, ...models);
          for (const m of models) console.log(`  ${m.id === agent.opts.model ? c.accent('●') : ' '} ${m.id}${m.name !== m.id ? c.gray(`  ${m.name}`) : ''}`);
        } catch (err) { console.log(c.red(`  ✗ ${describeError(err)}`)); }
        return true;
      case 'mode': case 'plan': {
        const target = cmd === 'plan' ? 'plan' : arg ? normalizeMode(arg) : cycle[(cycle.indexOf(permissions.mode) + 1) % cycle.length];
        if (!target) { console.log(c.red(`  Unknown mode "${arg}". One of: ${PERMISSION_MODES.join(', ')}`)); return true; }
        setMode(target);
        console.log(`  ${c.gray('⎿  Mode:')} ${modeColor(target, MODE_LABEL[target])}`);
        return true;
      }
      case 'mouse': {
        if (!screen.enabled) { console.log(c.gray('  The mouse is only captured in the full-screen view.')); return true; }
        const on = arg === 'on' ? true : arg === 'off' ? false : !screen.mouseEnabled;
        screen.setMouse(on);
        console.log(c.gray(on
          ? '  ⎿  Mouse on: the wheel scrolls the conversation. Hold Shift (Option on a Mac) to select text.'
          : '  ⎿  Mouse off: drag selects text again; PgUp/PgDn scroll the conversation.'));
        return true;
      }
      case 'init':
        await send(INIT_PROMPT);
        return true;
      case 'resume': {
        const sessions = listSessions(root).filter(s => s.id !== session.id).slice(0, 15);
        if (sessions.length === 0) { console.log(c.gray('  No earlier conversations in this directory.')); return true; }
        const choice = await select(sessions.map(s => `${clip(s.title || '(untitled)', 50)} ${c.gray(`${s.updated.slice(0, 16).replace('T', ' ')} · ${s.messages.length} msgs`)}`));
        if (choice !== null) {
          persist();
          session = sessions[choice];
          agent.clear();
          agent.messages = session.messages;
          agent.usage = session.usage ?? { prompt: 0, completion: 0 };
          console.log(c.gray(`  ⎿  Resumed "${session.title}". Files must be re-read before they are edited.`));
          refreshBar();
        }
        return true;
      }
      case 'todos':
        if (agent.todos.length === 0) console.log(c.gray('  No todos.'));
        for (const t of agent.todos) console.log(`  ${t.status === 'completed' ? c.green('☒') : t.status === 'in_progress' ? c.yellow('◼') : '☐'} ${t.content}`);
        return true;
      case 'cost': case 'usage':
        console.log(`  ${c.gray('input tokens ')} ${agent.usage.prompt.toLocaleString()}\n  ${c.gray('output tokens')} ${agent.usage.completion.toLocaleString()}\n  ${c.gray('last request ')} ${agent.lastPromptTokens.toLocaleString()} tokens of context${agent.opts.contextWindow ? ` / ${agent.opts.contextWindow.toLocaleString()}` : ''}`);
        return true;
      case 'status': {
        const instr = loadInstructions(root);
        console.log([
          `  ${c.gray('endpoint')}  ${opts.config.endpoint}`,
          `  ${c.gray('api key ')}  ${maskKey(opts.config.apiKey)}`,
          `  ${c.gray('model   ')}  ${agent.opts.model}`,
          `  ${c.gray('mode    ')}  ${modeColor(permissions.mode, MODE_LABEL[permissions.mode])}`,
          `  ${c.gray('root    ')}  ${root}`,
          `  ${c.gray('session ')}  ${session.id}`,
          `  ${c.gray('instructions')} ${instr.length ? instr.map(f => `${displayPath(f.path, root)}${!f.truncated ? '' : f.text ? ' (truncated)' : ' (omitted)'}`).join(', ') : 'none'}`,
        ].join('\n'));
        return true;
      }
      default:
        console.log(c.red(`  Unknown command /${cmd}. /help lists them.`));
        return true;
    }
  };

  await screen.enable();
  ide.start();
  banner();
  refreshBar();
  // No window reports this project yet: put the bridge extension into the editor.
  if (!ide.state) {
    void ensureIdeBridge().then(result => {
      if (result === 'installed' || result === 'updated') {
        console.log(c.gray(`  ⧉ ${result === 'installed' ? 'Installed' : 'Updated'} the KEDTec CLI Bridge in VS Code, so your open file and selection show here.`));
        console.log(c.gray('    If they do not appear in a few seconds, run "Developer: Reload Window".\n'));
      } else if (result === 'failed') {
        console.log(c.gray('  ⧉ Could not install the KEDTec CLI Bridge in VS Code; the open file and selection will not show here.\n'));
      }
    });
  }
  if (agent.messages.length > 0) console.log(c.gray(`  Continuing "${session.title}" (${agent.messages.length} messages).\n`));
  if (opts.initialPrompt) {
    console.log(`${c.gray('>')} ${opts.initialPrompt}`);
    await send(opts.initialPrompt);
  }

  for (;;) {
    // The pinned layout shows the mode under the box; the plain prompt has to
    // carry it itself.
    const mode = permissions.mode;
    const prefix = screen.enabled || mode === 'default' ? '' : `${modeColor(mode, mode === 'acceptEdits' ? 'accept-edits' : mode)} `;
    const answer = await input.ask(screen.enabled ? `${c.bold('❯')} ` : `${prefix}${c.accent('>')} `, {
      placeholder: agent.messages.length === 0 ? 'Try "explain how this project is structured"' : 'Ask KEDTec anything',
    });
    if (answer.kind === 'eof') break;
    if (answer.kind === 'interrupt') {
      if (Date.now() - lastInterrupt < 1500) break;
      lastInterrupt = Date.now();
      console.log(c.gray('  (press ctrl+c again to exit)'));
      continue;
    }
    const text = answer.text.trim();
    if (!text) continue;
    // The box empties on submit, so the message is written into the transcript.
    if (screen.enabled) echo(text);
    if (text.startsWith('/') && !text.startsWith('//')) {
      if (!(await command(text))) break;
      continue;
    }
    if (text.startsWith('!')) {
      const cmd = text.slice(1).trim();
      if (!cmd) continue;
      current = new AbortController();
      keys.start();
      const res = await runShell(cmd, root, 600_000, current.signal);
      keys.stop();
      current = null;
      const out = res.output.trimEnd();
      if (out) console.log(out.split('\n').map(l => `  ${l}`).join('\n'));
      console.log(c.gray(`  ⎿  exit ${res.code}`));
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
  console.log(c.gray(`\nSession saved — resume with: kedtec --continue`));
  process.exit(0);
}

// The mode picked last becomes the default for the next session — except
// bypass, which has to be asked for each time (--dangerously-skip-permissions):
// a session that silently starts with every prompt skipped is not one anybody
// chose. A flag or KEDTEC_PERMISSION_MODE still wins over what is saved here.
function rememberMode(mode: PermissionMode): void {
  if (mode === 'bypass') return;
  try {
    const stored = readStoredConfig();
    if (stored.permissionMode === mode) return;
    writeStoredConfig({ ...stored, permissionMode: mode });
  } catch { /* remembering is a convenience */ }
}

const SLASH_COMMANDS = ['/help', '/clear', '/compact', '/model', '/models', '/mode', '/plan', '/init', '/resume', '/todos', '/cost', '/status', '/mouse', '/exit'];

function echo(text: string): void {
  const lines = text.split('\n');
  console.log(`\n${c.gray('>')} ${lines[0]}${lines.slice(1).map(l => `\n  ${l}`).join('')}`);
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

async function askPermission(req: PermissionRequest, renderer: TerminalRenderer, input: Prompter) {
  renderer.spinner.stop();
  const width = Math.min(columns() - 2, 100);
  console.log(c.yellow(`  ${'─'.repeat(width - 2)}`));
  console.log(`  ${c.bold(c.yellow(req.kind === 'command' ? 'Run this command?' : req.title))}`);
  if (req.detail) {
    if (req.kind === 'edit') {
      const lines = req.detail.split('\n');
      const shown = lines.slice(0, 80).join('\n');
      console.log(colorDiff(shown));
      if (lines.length > 80) console.log(c.gray(`    … ${lines.length - 80} more diff lines`));
    } else {
      console.log(req.detail.split('\n').slice(0, 30).map(l => `    ${c.cyan(l)}`).join('\n'));
    }
  }
  for (const w of req.warnings ?? []) console.log(`  ${c.yellow('⚠')} ${w}`);
  const always = req.kind === 'edit' && !req.outsideRoot
    ? 'Yes, and allow all edits this session'
    : req.kind === 'command' && req.commandPrefix
      ? `Yes, and don't ask again for ${c.bold(req.commandPrefix)} commands this session`
      : undefined;
  const options = ['Yes', ...(always ? [always] : []), 'No, and tell KEDTec what to do differently (esc)'];
  if (req.kind === 'edit') console.log(`  ${c.gray('Apply this change?')}`);
  const choice = await select(options);
  const noIndex = options.length - 1;
  if (choice === 0) return { allow: true as const };
  if (always && choice === 1) return { allow: true as const, always: true };
  const fb = choice === noIndex || choice === null
    ? await input.ask(`  ${c.gray('↳ instead (enter to just decline):')} `, { history: false, multiline: false })
    : { kind: 'eof' as const };
  return { allow: false as const, feedback: fb.kind === 'line' ? fb.text : undefined };
}
