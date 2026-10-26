import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { Agent } from './agent';
import { ContentPart, ModelInfo, describeError, listModels, mergeCustomModels } from './client';
import {
  CustomModel, PERMISSION_MODES, PermissionMode, ResolvedConfig, maskKey, normalizeMode, readCustomModels, readStoredConfig,
  rememberMode, removeCustomModel, resolveKey, saveCustomModel, writeStoredConfig,
} from './config';
import { ImageAttachment, dataUrl, imageFromFile } from './images';
import { PastedText, withPastes } from './pastes';
import { LineInput, PanelTab, Prompter, TurnKeys, questionForm, select, tabbedPanel } from './input';
import { STRUCTURE_MEMORY, deleteMemory, isMemoryName, listMemories } from './memory';
import { Asker, PermissionRequest, Permissions } from './permissions';
import { INIT_PROMPT, MEMORY_REFRESH_PROMPT, loadInstructions } from './prompt';
import { TerminalRenderer } from './render';
import { IdeContext, IdeWatcher, ideLabel } from './ide';
import { ensureIdeBridge } from './ideBridge';
import { Completer, Screen } from './screen';
import { SessionFile, deleteSession, listSessions, newSessionId, renameSession, saveSession, titleFrom } from './session';
import { expandMentions as expandMentionsIn, makeMentionFinder } from './mentions';
import { Question, QuestionAnswers, displayPath, questionsInProse, runShell } from './tools';

// Kept here as well, where the CLI's callers and tests have always found them.
export { expandMentions, parseMention } from './mentions';
import { TERMINAL_TITLE, c, clip, colorDiff, columnLayout, columns, logo, setTerminalTitle, stripAnsi, userBar, wrapText } from './ui';

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
  // False with --no-project-config: the project's instruction files are not read.
  projectConfig: boolean;
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

// The slash commands: the /help Commands tab and Tab completion both read this.
const COMMANDS: { name: string; args?: string; about: string }[] = [
  { name: '/help', about: 'this help' },
  { name: '/clear', about: 'start a new conversation' },
  { name: '/compact', args: '[focus]', about: 'summarise the conversation to free context' },
  { name: '/model', args: '[id|add|remove id]', about: 'switch the model (no id: pick from a list), or add a custom one' },
  { name: '/models', about: 'list the models the endpoint serves' },
  { name: '/mode', args: '[name]', about: 'permission mode: default · acceptEdits · auto · plan · bypass (no name: cycle)' },
  { name: '/plan', about: 'shortcut for /mode plan' },
  { name: '/init', about: 'write a KEDTEC.md describing this project' },
  { name: '/memory', args: '[refresh|forget name]', about: 'list what the agent remembers about this project, re-learn its structure, or drop a memory' },
  { name: '/resume', about: 'reopen an earlier conversation in this directory' },
  { name: '/sessions', about: "this workspace's saved conversations: resume, rename, delete one or all" },
  { name: '/todos', about: 'show the current checklist' },
  { name: '/cost', about: 'token usage this session' },
  { name: '/status', about: 'endpoint, model, mode, key and instruction files' },
  { name: '/mouse', args: '[on|off]', about: 'mouse-wheel scrolling (off gives plain drag-to-select back)' },
  { name: '/exit', about: 'quit (or ctrl+d)' },
];

const SLASH_COMMANDS = COMMANDS.map(cmd => cmd.name);

// What the input box offers while typing: the slash commands matching a
// leading "/", and for an "@" the files mentions.ts suggests.
export function makeCompleter(root: string, onListed?: () => void): Completer {
  const mentions = makeMentionFinder(root, onListed);

  return (text, cursor) => {
    if (/^\/\S*$/.test(text)) {
      const typed = text.toLowerCase();
      const items = COMMANDS.filter(cmd => cmd.name.startsWith(typed)).map(cmd => ({
        label: cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name, detail: cmd.about, value: `${cmd.name} `, submit: true,
      }));
      return items.length ? { items, start: 0, end: text.length } : null;
    }
    const at = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
    if (!at) return null;
    const start = cursor - at[1].length - 1;
    let end = cursor;
    while (end < text.length && !/\s/.test(text[end])) end++;
    // A folder stays open for the next level; a file ends the mention.
    const items = mentions(at[1]).map(p => ({ label: p, value: p.endsWith('/') ? `@${p}` : `@${p} ` }));
    return items.length ? { items, start, end } : null;
  };
}

const HELP_URL = 'https://github.com/sovannDeveloper/kedtec-cli#readme';

// The /help panel's tabs. The scrolling keys exist only in the full-screen view.
function helpTabs(fullScreen: boolean): PanelTab[] {
  const general: PanelTab = {
    name: 'General',
    body: width => [
      ...wrapText('KEDTec understands your codebase, makes edits with your permission, and runs commands — right from your terminal.', width).split('\n'),
      c.bold('Shortcuts'),
      ...columnLayout([
        ['! for shell mode', '/ for commands', '@ for file paths', '\\ at line end for newline'],
        ['esc to clear input', 'esc to interrupt KEDTec', 'shift + tab to cycle modes', 'ctrl + j for newline', 'tab to complete / and @', ...(fullScreen ? ['ctrl + v or cmd + v to paste an image'] : [])],
        [
          '↑ / ↓ for history',
          ...(fullScreen ? ['pgup / pgdn to scroll', 'shift + ↑ / ↓ to scroll a line', 'ctrl + l to clear the screen'] : []),
          'ctrl + c twice to exit',
        ],
      ], width),
      '',
      ...(width >= 16 + HELP_URL.length ? [`For more help: ${c.cyan(HELP_URL)}`] : ['For more help:', c.cyan(HELP_URL)]),
    ],
  };
  const commands: PanelTab = {
    name: 'Commands',
    body: width => {
      const label = (cmd: typeof COMMANDS[number]) => (cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name);
      const col = Math.max(...COMMANDS.map(cmd => label(cmd).length)) + 3;
      return COMMANDS.map(cmd => {
        const about = width - col > 10 ? clip(cmd.about, width - col) : '';
        return `${c.bold(cmd.name)}${cmd.args ? ` ${c.gray(cmd.args)}` : ''}${' '.repeat(col - label(cmd).length)}${c.gray(about)}`.trimEnd();
      });
    },
  };
  return [general, commands];
}

// The message as the model gets it: each pasted image right after its
// "[Image #n]" (its first one, so a placeholder inside an attached file is
// left alone), and the images mentioned with @ at the end. Plain text when
// there are none.
export function withImages(text: string, pasted: Map<number, ImageAttachment> | undefined, mentioned: ImageAttachment[] = []): string | ContentPart[] {
  if (!pasted?.size && mentioned.length === 0) return text;
  const parts: ContentPart[] = [];
  const image = (img: ImageAttachment): ContentPart => ({ type: 'image_url', image_url: { url: dataUrl(img) } });
  const placed = new Set<number>();
  let last = 0;
  for (const m of text.matchAll(/\[Image #(\d+)\]/g)) {
    const n = Number(m[1]);
    const img = pasted?.get(n);
    if (!img || placed.has(n)) continue;
    placed.add(n);
    const end = m.index! + m[0].length;
    parts.push({ type: 'text', text: text.slice(last, end) }, image(img));
    last = end;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  parts.push(...mentioned.map(image));
  return parts;
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const { agent, permissions, root } = opts;
  // Name the tab after the conversation ("✳ Fix todo widget overflow", or
  // "✳ KEDTec" before it has a title) rather than "node", and give it back on
  // every way out — /exit, ctrl+c twice, a crash — so the shell's tab is not
  // left wearing it. It is set again at every prompt as well as whenever the
  // title changes: VS Code can drop a title it was given once it notices the
  // process changed, so once at start-up is not enough.
  process.title = 'kedtec';
  const showTitle = () => setTerminalTitle(session.title ? `✳ ${clip(session.title, 40)}` : TERMINAL_TITLE);
  process.on('exit', () => setTerminalTitle(''));
  // On a capable terminal the input box and status line are pinned to the
  // bottom (screen.ts); otherwise a plain readline prompt follows the output.
  const screen = new Screen();
  const input: Prompter = Screen.supported() ? screen : new LineInput();
  screen.completions = SLASH_COMMANDS;
  screen.completer = makeCompleter(root, () => screen.refreshSuggestions());
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
  // ask_user, the same way: a form of the model's questions.
  agent.opts.ask = questions => keys.suspend(() => { screen.scrollToBottom(); return askQuestions(questions, renderer); });

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
    const mark = columns() >= 60 ? logo() : [];
    const info = [
      `${mark.length ? '' : `${c.accent('✻')} `}${c.bold('KEDTec CLI')} ${c.gray(`v${VERSION}`)}`,
      '',
      `${c.gray('model')}  ${model}`,
      `${c.gray('mode ')}  ${modeColor(permissions.mode, MODE_LABEL[permissions.mode])}`,
      `${c.gray('cwd  ')}  ${clip(root, 60)}`,
    ];
    // The mark on the left, the lines beside it from its second row.
    const lines = mark.length ? mark.map((m, i) => (info[i - 1] ? `${m}   ${info[i - 1]}` : m)) : info;
    console.log(`${lines.map(l => (l ? `  ${l}` : '')).join('\n')}\n`);
    const instr = loadInstructions(root, opts.projectConfig).map(f => displayPath(f.path, root));
    if (instr.length) console.log(c.gray(`  instructions: ${instr.join(', ')}`));
    console.log(c.gray('  /help for commands · ! runs a shell command · @file attaches a file · esc interrupts\n'));
  };

  const persist = () => {
    session.messages = agent.messages;
    session.usage = agent.usage;
    session.model = agent.opts.model;
    saveSession(session);
  };

  const send = async (text: string, pasted?: Map<number, ImageAttachment>, pastes?: Map<number, PastedText>): Promise<void> => {
    // @mentions are looked for in what was typed, not in pasted text.
    const typed = expandMentionsIn(text, root, agent.readState);
    const { attached, skipped, images } = typed;
    const mentioned = withPastes(typed.text, pastes);
    const fromIde = ideContext.forMessage(ide.state, [...(pastes?.values() ?? [])].map(p => p.text));
    const expanded = fromIde ? `${mentioned}\n\n${fromIde.text}` : mentioned;
    const mentionedImages: ImageAttachment[] = [];
    for (const { path: file, label } of images) {
      const img = await imageFromFile(file);
      if (typeof img === 'string') console.log(c.yellow(`  ⎿  cannot attach ${label}: ${img}`));
      else { mentionedImages.push(img); attached.push(label); }
    }
    if (pasted?.size) console.log(c.gray(`  ⎿  attached ${pasted.size} image${pasted.size === 1 ? '' : 's'}`));
    if (fromIde?.note) console.log(c.gray(`  ${fromIde.note}`));
    if (attached.length) console.log(c.gray(`  ⎿  attached ${attached.join(', ')}`));
    if (skipped.length) console.log(c.yellow(`  ⎿  too big to attach: ${skipped.join(', ')} — name lines, e.g. @file#L1-200`));
    if (!session.title || session.title === '(untitled)') { session.title = titleFrom(text); session.titleSource = 'prompt'; showTitle(); }
    current = new AbortController();
    renderer.beginTurn();
    renderer.thinking();
    keys.start();
    let done = '';
    let asked: Question[] | null = null;
    try {
      const result = await agent.run(withImages(expanded, pasted, mentionedImages), renderer, current.signal);
      if (result.error) console.log(`\n${c.red('✗')} ${result.error}`);
      // "✻ Baked for 9s" under a finished answer; an interrupted turn has
      // already said so.
      if (!result.stopped) done = renderer.endTurn();
      if (!result.stopped && !result.error) autoName();
      // A reply that asks in prose ("Would you like me to: 1. … 2. …") gets
      // the form ask_user would have shown.
      const last = agent.messages[agent.messages.length - 1];
      if (!result.stopped && !result.error && last?.role === 'assistant' && !last.tool_calls && last.content) asked = questionsInProse(last.content);
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
    if (asked) {
      const answer = await askQuestions(asked, renderer);
      if (answer.kind !== 'answered' || answer.answers.every(a => a === undefined)) return;
      // The answer is sent as the next message, as if typed.
      const reply = asked.length === 1
        ? answer.answers[0]!
        : asked.map((q, i) => (answer.answers[i] === undefined ? '' : `${q.question} → ${answer.answers[i]}`)).filter(Boolean).join('\n');
      echo(reply);
      return send(reply);
    }
  };

  // Switch to a model and make it the default for the next session.
  const useModel = (m: ModelInfo) => {
    opts.setModel(m);
    refreshBar();
    const save = readStoredConfig();
    save.model = m.id;
    writeStoredConfig(save);
    console.log(c.gray(`  ⎿  Model: ${m.id}${stripAnsi(customTag(m))} (saved as default)`));
  };
  // The model list after a custom model was added or removed.
  const syncCustomModels = () => {
    opts.models.splice(0, opts.models.length, ...mergeCustomModels(opts.models.filter(m => !m.custom), readCustomModels()));
  };

  // The model names a conversation once its first exchange is done, beside
  // the conversation rather than in its way. One try per conversation: a
  // backend that cannot do it is not asked again every turn. Nothing changes
  // if it fails, if the conversation was renamed meanwhile, or if another one
  // took its place. A title that lands during a turn is saved with that turn.
  const named = new WeakSet<SessionFile>();
  const autoName = () => {
    const target = session;
    if (named.has(target) || target.titleSource === 'ai' || target.titleSource === 'user') return;
    named.add(target);
    agent.suggestTitle().then(title => {
      if (!title || session !== target || target.titleSource === 'user') return;
      target.title = title;
      target.titleSource = 'ai';
      showTitle();
      if (!current) persist();
    }, () => { /* the first-line title stays */ });
  };

  const resume = (picked: SessionFile) => {
    persist();
    session = picked;
    agent.clear();
    agent.messages = session.messages;
    agent.usage = session.usage ?? { prompt: 0, completion: 0 };
    console.log(c.gray(`  ⎿  Resumed "${session.title}". Files must be re-read before they are edited.`));
    refreshBar();
  };

  const command = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'help': case '?':
        await tabbedPanel('Help', helpTabs(screen.enabled));
        console.log(c.gray('  ⎿  Help dialog dismissed'));
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
        if (arg === 'add') {
          const model = await askCustomModel(input, opts.config);
          if (!model) { console.log(c.gray('  ⎿  No model added.')); return true; }
          saveCustomModel(model);
          syncCustomModels();
          useModel(opts.models.find(m => m.id === model.id)!);
          return true;
        }
        const rm = /^(?:remove|rm)\s+(\S+)$/.exec(arg);
        if (rm) {
          if (!removeCustomModel(rm[1])) { console.log(c.red(`  No custom model "${rm[1]}". /model lists them.`)); return true; }
          syncCustomModels();
          console.log(c.gray(`  ⎿  Removed ${rm[1]}.`));
          // Still on the model just removed: on to the endpoint's first one.
          if (agent.opts.model === rm[1] && opts.models[0]) useModel(opts.models[0]);
          return true;
        }
        if (arg) {
          const found = opts.models.find(m => m.id === arg);
          opts.setModel(found ?? arg);
          refreshBar();
          console.log(c.gray(`  ⎿  Model: ${agent.opts.model}${found ? '' : ' (not in the endpoint\'s list — using it as typed; /model add saves it)'}`));
          return true;
        }
        const labels = opts.models.map(m => `${m.name !== m.id ? `${m.id} ${c.gray(m.name)}` : m.id}${customTag(m)}`);
        const choice = await select([...labels, c.accent('+ Add a custom model…')],
          Math.max(0, opts.models.findIndex(m => m.id === agent.opts.model)),
          { title: c.gray('  Choose a model (enter selects, esc cancels):'), transient: true });
        if (choice === null) console.log(c.gray(`  ⎿  Model: ${agent.opts.model} (unchanged)`));
        else if (choice === opts.models.length) return command('/model add');
        else useModel(opts.models[choice]);
        return true;
      }
      case 'models': {
        let listed: ModelInfo[] = opts.models.filter(m => !m.custom);
        try { listed = await listModels(opts.config.endpoint, opts.config.apiKey); } catch (err) { console.log(c.red(`  ✗ ${describeError(err)}`)); }
        opts.models.splice(0, opts.models.length, ...mergeCustomModels(listed, readCustomModels()));
        for (const m of opts.models) console.log(`  ${m.id === agent.opts.model ? c.accent('●') : ' '} ${m.id}${m.name !== m.id ? c.gray(`  ${m.name}`) : ''}${customTag(m)}`);
        if (!opts.models.some(m => m.custom)) console.log(c.gray('  /model add adds a model from any OpenAI-compatible endpoint.'));
        return true;
      }
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
      case 'memory': {
        const dir = agent.opts.memoryDir;
        if (!dir) { console.log(c.gray('  Memory is off in this session (--no-project-config).')); return true; }
        const [sub, name] = arg.split(/\s+/);
        if (sub === 'refresh') { await send(MEMORY_REFRESH_PROMPT); return true; }
        if (sub === 'forget') {
          if (!isMemoryName(name)) { console.log(c.red('  Usage: /memory forget <name>  (names are listed by /memory)')); return true; }
          console.log(c.gray(deleteMemory(dir, name) ? `  ⎿  Forgot "${name}".` : `  ⎿  No memory named "${name}".`));
          return true;
        }
        if (sub) { console.log(c.red(`  Unknown /memory ${sub}. Use /memory, /memory refresh or /memory forget <name>.`)); return true; }
        const all = listMemories(dir);
        console.log(c.gray(`  ${dir}`));
        if (all.length === 0) console.log(c.gray(`  No memories yet. The agent maps the project into "${STRUCTURE_MEMORY}" on your first request; /memory refresh does it now.`));
        for (const m of all) console.log(`  ${c.accent(m.name)} ${c.gray(`${m.type} · ${m.updated.toISOString().slice(0, 10)}`)}${m.description ? ` — ${m.description}` : ''}`);
        return true;
      }
      case 'resume': {
        const sessions = listSessions(root).filter(s => s.id !== session.id).slice(0, 15);
        if (sessions.length === 0) { console.log(c.gray('  No earlier conversations in this directory.')); return true; }
        const choice = await select(sessions.map(s => `${clip(s.title || '(untitled)', 50)} ${c.gray(`${s.updated.slice(0, 16).replace('T', ' ')} · ${s.messages.length} msgs`)}`), 0,
          { title: c.gray('  Resume a conversation (enter selects, esc cancels):'), transient: true });
        if (choice !== null) resume(sessions[choice]);
        return true;
      }
      case 'sessions': {
        persist();
        const picked = await manageSessions(root, session, input);
        if (picked) resume(picked);
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
        const instr = loadInstructions(root, opts.projectConfig);
        const active = opts.models.find(m => m.id === agent.opts.model);
        console.log([
          `  ${c.gray('endpoint')}  ${active?.endpoint ?? opts.config.endpoint}`,
          `  ${c.gray('api key ')}  ${maskKey(active?.endpoint ? resolveKey(active.apiKey) ?? '' : opts.config.apiKey)}`,
          `  ${c.gray('model   ')}  ${agent.opts.model}`,
          `  ${c.gray('mode    ')}  ${modeColor(permissions.mode, MODE_LABEL[permissions.mode])}`,
          `  ${c.gray('root    ')}  ${root}`,
          `  ${c.gray('session ')}  ${session.id}`,
          `  ${c.gray('memory  ')}  ${agent.opts.memoryDir ? `${listMemories(agent.opts.memoryDir).length} saved (/memory)` : 'off'}`,
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
    echo(opts.initialPrompt);
    await send(opts.initialPrompt);
  }

  for (;;) {
    // The pinned layout shows the mode under the box; the plain prompt has to
    // carry it itself.
    const mode = permissions.mode;
    const prefix = screen.enabled || mode === 'default' ? '' : `${modeColor(mode, mode === 'acceptEdits' ? 'accept-edits' : mode)} `;
    showTitle();
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
    await send(text.startsWith('//') ? text.slice(1) : text, answer.images, answer.pastes);
  }
  persist();
  ide.stop();
  screen.disable();
  console.log(c.gray(`\nSession saved — resume with: kedtec --continue`));
  process.exit(0);
}

// "  custom · openrouter.ai" after a hand-added model's name.
export function customTag(m: ModelInfo): string {
  if (!m.custom) return '';
  let host = '';
  try { host = m.endpoint ? new URL(m.endpoint).host : ''; } catch { host = m.endpoint ?? ''; }
  return c.gray(`  custom${host ? ` · ${host}` : ''}`);
}

// What /model add and `kedtec models add` ask. A blank endpoint means the
// configured one, which needs no key of its own. The endpoint's model list is
// read as a check that only warns: plenty of servers serve models they do not list.
export async function askCustomModel(input: Prompter, cfg: { endpoint: string; apiKey: string }): Promise<CustomModel | null> {
  const ask = async (q: string, extra: { secret?: boolean; placeholder?: string } = {}) => {
    const a = await input.ask(q, { history: false, multiline: false, ...extra });
    return a.kind === 'line' ? a.text.trim() : null;
  };
  const id = await ask(`  Model id ${c.gray('(as the endpoint names it)')}: `, { placeholder: 'e.g. gpt-4o-mini, llama3.1:8b, deepseek/deepseek-chat' });
  if (!id) return null;
  const ep = await ask(`  Endpoint ${c.gray(`[${cfg.endpoint}]`)}: `, { placeholder: 'enter keeps it; or e.g. https://openrouter.ai/api/v1, http://localhost:11434/v1' });
  if (ep === null) return null;
  const endpoint = ep && ep.replace(/\/+$/, '') !== cfg.endpoint ? ep.replace(/\/+$/, '') : undefined;
  if (endpoint) {
    try { if (!/^https?:$/.test(new URL(endpoint).protocol)) throw new Error(); } catch {
      console.log(c.red(`  ✗ "${endpoint}" is not an http(s) URL.`));
      return null;
    }
  }
  let apiKey: string | undefined;
  if (endpoint) {
    const key = await ask(`  API key ${c.gray('(blank for none, or $ENV_VAR to read it from the environment)')}: `, { secret: true });
    if (key === null) return null;
    apiKey = key || undefined;
  }
  const cw = await ask(`  Context window ${c.gray('[unknown]')}: `, { placeholder: 'tokens, e.g. 128000 or 128k; enter to skip' });
  if (cw === null) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(k)?$/i.exec(cw.replace(/[_,]/g, ''));
  const contextWindow = m ? Math.round(Number(m[1]) * (m[2] ? 1000 : 1)) || undefined : undefined;
  try {
    const listed = await listModels(endpoint ?? cfg.endpoint, endpoint ? resolveKey(apiKey) ?? '' : cfg.apiKey);
    console.log(listed.some(l => l.id === id)
      ? c.green(`  ✓ ${id} is served there.`)
      : c.yellow(`  ! The endpoint answered but does not list ${id}; saved anyway.`));
  } catch (err) {
    console.log(c.yellow(`  ! Could not read the endpoint's model list (${describeError(err)}); saved anyway.`));
  }
  return { id, endpoint, apiKey, contextWindow };
}

function echo(text: string): void {
  const lines = text.split('\n');
  console.log(`\n${lines.map((l, i) => userBar(`${i === 0 ? c.gray('❯') : ' '} ${l}`)).join('\n')}`);
}

// /sessions: this workspace's saved conversations, newest first, under a
// "Delete all…" entry. Choosing one offers what can be done with it; resolves
// with the one to resume, or null. The current conversation is never deleted.
async function manageSessions(root: string, current: SessionFile, input: Prompter): Promise<SessionFile | null> {
  const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  const plural = (n: number) => `${n} conversation${n === 1 ? '' : 's'}`;
  // The selection starts on the newest conversation, not on "Delete all…".
  let at = 1;
  for (;;) {
    const all = listSessions(root);
    const deletable = all.filter(s => s.id !== current.id);
    // The current conversation can be neither resumed nor deleted, so a list
    // of only it would be a menu with nowhere to go.
    if (deletable.length === 0) {
      console.log(c.gray(`  ⎿  ${all.length ? 'Only this conversation is saved in this workspace.' : 'No conversations are saved in this workspace yet.'}`));
      return null;
    }
    at = Math.min(Math.max(at, 1), all.length);
    const rows = all.map(s => `${clip(s.title || '(untitled)', 50)}${s.id === current.id ? c.accent(' (current)') : ''} `
      + c.gray(`${when(s.updated)} · ${s.messages.length} msgs`));
    const choice = await select([c.red('Delete all…'), ...rows], at, {
      title: c.gray(`  ${plural(all.length)} saved in this workspace:`),
      footer: c.gray('↑/↓ to move · enter to open · esc to close'),
      transient: true,
      maxVisible: Math.max(5, Math.min(15, (process.stdout.rows || 24) - 14)),
    });
    if (choice === null) return null;
    at = choice;
    if (choice === 0) {
      const sure = await select(['No, keep them', `Yes, delete ${plural(deletable.length)}`], 0, {
        title: c.yellow('  Delete this workspace\'s saved conversations? It cannot be undone. The current one is kept.'),
        transient: true,
      });
      if (sure === 1) console.log(c.gray(`  ⎿  Deleted ${plural(deletable.filter(deleteSession).length)}.`));
      continue;
    }
    const s = all[choice - 1];
    const isCurrent = s.id === current.id;
    const actions: { label: string; run: () => Promise<SessionFile | null | 'back'> }[] = [];
    if (!isCurrent) actions.push({ label: 'Resume', run: async () => s });
    actions.push({
      label: 'Rename',
      run: async () => {
        const a = await input.ask(`  ${c.gray('New title:')} `, { history: false, multiline: false, placeholder: s.title });
        const title = a.kind === 'line' ? a.text.trim() : '';
        if (!title) return 'back';
        renameSession(s, title);
        if (isCurrent) { current.title = title; current.titleSource = 'user'; }
        console.log(c.gray(`  ⎿  Renamed to "${title}".`));
        return 'back';
      },
    });
    if (!isCurrent) {
      actions.push({
        label: 'Delete',
        run: async () => {
          const sure = await select(['No, keep it', `Yes, delete "${clip(s.title || '(untitled)', 40)}"`], 0,
            { title: c.yellow('  Delete this conversation? It cannot be undone.'), transient: true });
          if (sure === 1) console.log(c.gray(deleteSession(s) ? `  ⎿  Deleted "${s.title}".` : '  ⎿  Could not delete it.'));
          return 'back';
        },
      });
    }
    actions.push({ label: 'Back', run: async () => 'back' });
    const act = await select(actions.map(a => a.label), 0, {
      title: `  ${c.bold(s.title || '(untitled)')}\n  ${c.gray(`${s.messages.length} msgs · started ${when(s.created)} · last ${when(s.updated)} · ${s.id}`)}`,
      transient: true,
    });
    if (act === null) continue;
    const result = await actions[act].run();
    if (result !== 'back') return result;
  }
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

// The model's questions, as the form in input.ts.
function askQuestions(questions: Question[], renderer: TerminalRenderer): Promise<QuestionAnswers> {
  renderer.spinner.stop();
  return questionForm(questions);
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
