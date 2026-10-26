import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent, AgentEvents } from '../../src/agent';
import { ContentPart, ModelInfo, contentText, createClient, describeError, listModels, mergeCustomModels } from '../../src/client';
import {
  DEFAULT_ENDPOINT, PermissionMode, ResolvedConfig, maskKey, normalizeMode, readProjectAllowedCommands, readStoredConfig, rememberMode,
  resolveConfig, resolveKey, writeStoredConfig,
} from '../../src/config';
import { IdeContext, IdeState, ideLabel } from '../../src/ide';
import { MAX_IMAGE_BYTES } from '../../src/images';
import { STRUCTURE_MEMORY, deleteMemory, isMemoryName, listMemories, memoryDir } from '../../src/memory';
import { PermissionAnswer, PermissionRequest, Permissions } from '../../src/permissions';
import { INIT_PROMPT, MEMORY_REFRESH_PROMPT, buildSystemPrompt, findGitRoot, loadInstructions } from '../../src/prompt';
import { sourceRows } from '../../src/render';
import { SessionFile, listSessions, newSessionId, saveSession, titleFrom } from '../../src/session';
import { Question, QuestionAnswers, displayPath, findTool, questionsInProse } from '../../src/tools';
import { setColor, stripAnsi } from '../../src/ui';

// The chat panel: the CLI's agent (src/agent.ts and everything under it —
// tools, permissions, memory, sessions) running in the extension host, shown
// in a webview instead of a terminal. The webview (media/chat.js) only draws;
// every decision is made here, by the same code the CLI runs.
//
// It reads the same ~/.kedtec/config.json and saves conversations to the same
// sessions folder, so `kedtec -c` in a terminal continues a chat started here
// and the panel's history lists the CLI's conversations.

const VIEW_ID = 'kedtec.chat';
const MAX_TURNS = 100;

// The modes the mode menu offers. Bypass only when the configuration starts in
// it, as in the CLI: a stray click must not turn off every prompt.
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan'];

// What typing "/" offers, in this order; command() runs them.
const COMMANDS: { name: string; args?: string; about: string }[] = [
  { name: '/help', about: 'list these commands' },
  { name: '/clear', about: 'start a new conversation' },
  { name: '/compact', args: '[focus]', about: 'summarise the conversation to free context' },
  { name: '/model', args: '[id]', about: 'switch the model (no id: pick from a list)' },
  { name: '/mode', args: '[name]', about: 'permission mode: default · acceptEdits · auto · plan (no name: cycle)' },
  { name: '/plan', about: 'shortcut for /mode plan' },
  { name: '/init', about: 'write a KEDTEC.md describing this project' },
  { name: '/memory', args: '[refresh|forget name]', about: 'what the agent remembers about this project' },
  { name: '/resume', about: 'reopen an earlier conversation in this folder' },
  { name: '/todos', about: 'show the current checklist' },
  { name: '/cost', about: 'token usage this conversation' },
  { name: '/status', about: 'endpoint, model, mode, key and instruction files' },
  { name: '/login', about: 'set the endpoint, API key and default model' },
];

interface Core {
  root: string;
  cfg: ResolvedConfig;
  models: ModelInfo[];
  agent: Agent;
  permissions: Permissions;
  clientFor(info: ModelInfo | undefined): ReturnType<typeof createClient>;
}

type Pending =
  | { kind: 'permission'; resolve(answer: PermissionAnswer): void }
  | { kind: 'question'; resolve(answer: QuestionAnswers): void };

// One rendered row of a conversation loaded from disk.
type HistoryItem =
  | { type: 'user'; text: string; images: number }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; label: string; summary: string; isError: boolean }
  | { type: 'notice'; message: string };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = VIEW_ID;

  private view: vscode.WebviewView | undefined;
  private core: Core | null = null;
  private session: SessionFile | null = null;
  private current: AbortController | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private ideContext: IdeContext | null = null;
  private loading: Promise<void> | null = null;
  private readonly named = new WeakSet<SessionFile>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly editorState: () => IdeState) {
    // Tool output is shown as text, not drawn on a terminal.
    setColor(false);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage(msg => { void this.receive(msg); });
    view.onDidDispose(() => {
      this.view = undefined;
      this.current?.abort();
      this.settlePending();
    });
  }

  // The editor's file or selection changed: the label under the input follows it.
  editorChanged(): void {
    this.post({ type: 'context', label: ideLabel(this.editorState()) });
  }

  async newChat(): Promise<void> {
    await this.ensureCore();
    if (!this.core) return;
    this.stop();
    this.persist();
    this.core.agent.clear();
    this.session = this.freshSession(this.core);
    this.ideContext = new IdeContext(this.core.root);
    this.post({ type: 'reset', items: [] });
    this.showTitle('');
    this.postState();
  }

  async showHistory(): Promise<void> {
    await this.ensureCore();
    if (!this.core) return;
    const core = this.core;
    const sessions = listSessions(core.root);
    if (sessions.length === 0) { void vscode.window.showInformationMessage('No saved KEDTec conversations for this folder yet.'); return; }
    const picked = await vscode.window.showQuickPick(sessions.map(s => ({
      label: s.title || '(untitled)',
      description: `${s.updated.slice(0, 16).replace('T', ' ')} · ${s.messages.length} msgs`,
      detail: s.id === this.session?.id ? 'current conversation' : undefined,
      session: s,
    })), { title: 'Resume a KEDTec conversation', matchOnDescription: true });
    if (!picked || picked.session.id === this.session?.id) return;
    this.stop();
    this.persist();
    this.session = picked.session;
    core.agent.clear();
    core.agent.messages = picked.session.messages;
    core.agent.usage = picked.session.usage ?? { prompt: 0, completion: 0 };
    this.ideContext = new IdeContext(core.root);
    this.post({ type: 'reset', items: historyItems(picked.session, core.root) });
    this.showTitle(picked.session.title);
    this.post({ type: 'notice', message: 'Resumed. Files must be re-read before they are edited.' });
    this.postState();
    void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  // Endpoint, key and default model, the same three questions `kedtec login` asks.
  async signIn(): Promise<void> {
    const stored = readStoredConfig();
    const endpointIn = await vscode.window.showInputBox({
      title: 'KEDTec: endpoint', prompt: 'OpenAI-compatible base URL', value: stored.endpoint ?? DEFAULT_ENDPOINT, ignoreFocusOut: true,
    });
    if (endpointIn === undefined) return;
    const endpoint = (endpointIn.trim() || stored.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    const keyIn = await vscode.window.showInputBox({
      title: 'KEDTec: API key', prompt: stored.apiKey ? 'Leave empty to keep the current key' : 'From /admin/tokens', password: true, ignoreFocusOut: true,
    });
    if (keyIn === undefined) return;
    const apiKey = keyIn.trim() || stored.apiKey || '';
    let model = stored.model;
    try {
      const models = await listModels(endpoint, apiKey);
      if (models.length > 0) {
        const pick = await vscode.window.showQuickPick(models.map(m => ({ label: m.id, description: m.name !== m.id ? m.name : undefined })), {
          title: `KEDTec: default model (${models.length} available)`, ignoreFocusOut: true,
        });
        if (pick) model = pick.label;
      }
    } catch (err) {
      void vscode.window.showWarningMessage(`KEDTec: could not list models: ${describeError(err)}`);
    }
    writeStoredConfig({ ...stored, endpoint, apiKey, model });
    await this.reload();
  }

  // Configuration or workspace trust changed: rebuild the agent around the
  // conversation in progress, which buildCore takes back from the session.
  async reload(): Promise<void> {
    this.stop();
    this.persist();
    this.core = null;
    await this.ensureCore();
    this.postState();
  }

  // ── webview messages ──────────────────────────────────────────────────────

  private async receive(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        await this.ensureCore();
        if (this.core && this.session) {
          this.post({ type: 'reset', items: historyItems(this.session, this.core.root) });
          this.showTitle(this.session.title);
        }
        this.postState();
        this.editorChanged();
        break;
      }
      case 'send': await this.send(String(msg.text ?? ''), Array.isArray(msg.images) ? msg.images.map(String) : [], msg.includeEditor !== false); break;
      case 'stop': this.stop(); break;
      case 'newChat': await this.newChat(); break;
      case 'history': await this.showHistory(); break;
      case 'signIn': await this.signIn(); break;
      case 'retry': await this.reload(); break;
      case 'setMode': this.setMode(String(msg.mode)); break;
      case 'setModel': this.setModel(String(msg.id)); break;
      case 'openFile': await this.openFile(String(msg.path ?? '')); break;
      case 'permissionAnswer': {
        const p = this.take(Number(msg.id), 'permission');
        if (!p) break;
        const choice = msg.choice;
        p.resolve(choice === 'yes' ? { allow: true } : choice === 'always' ? { allow: true, always: true }
          : { allow: false, feedback: typeof msg.feedback === 'string' ? msg.feedback : undefined });
        break;
      }
      case 'questionAnswer': {
        const p = this.take(Number(msg.id), 'question');
        if (!p) break;
        if (msg.kind === 'answered' && Array.isArray(msg.answers)) {
          p.resolve({ kind: 'answered', answers: msg.answers.map(a => (typeof a === 'string' && a.trim() ? a.trim() : undefined)) });
        } else p.resolve({ kind: msg.kind === 'chat' ? 'chat' : 'dismissed' });
        break;
      }
    }
  }

  private take<K extends Pending['kind']>(id: number, kind: K): Extract<Pending, { kind: K }> | undefined {
    const p = this.pending.get(id);
    if (!p || p.kind !== kind) return undefined;
    this.pending.delete(id);
    return p as Extract<Pending, { kind: K }>;
  }

  // ── the agent ─────────────────────────────────────────────────────────────

  private ensureCore(): Promise<void> {
    if (this.core) return Promise.resolve();
    if (!this.loading) this.loading = this.buildCore().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async buildCore(): Promise<void> {
    const root = workspaceRoot();
    if (!root) { this.post({ type: 'fatal', message: 'Open a folder to chat with KEDTec about it.' }); return; }
    const cfg = resolveConfig();
    let listed: ModelInfo[] = [];
    let listError = '';
    try { listed = await listModels(cfg.endpoint, cfg.apiKey); } catch (err) { listError = describeError(err); }
    const models = mergeCustomModels(listed, cfg.customModels);
    const startModel = cfg.model || listed[0]?.id || models[0]?.id;
    if (!startModel) {
      this.post({
        type: 'fatal', signIn: true,
        message: listError
          ? `Could not reach ${cfg.endpoint}: ${listError}`
          : `${cfg.endpoint} lists no models. Sign in, or add a custom model with \`kedtec models add\`.`,
      });
      return;
    }

    // A window in Restricted Mode is the CLI's --no-project-config: the
    // project's instruction files, pre-approved commands and memory are the
    // words of whoever wrote the checkout, so none of them is read.
    const projectConfig = vscode.workspace.isTrusted;
    const projectRoot = findGitRoot(root) ?? root;
    const client = createClient(cfg.endpoint, cfg.apiKey);
    const clientFor = (info: ModelInfo | undefined) => (info?.endpoint ? createClient(info.endpoint, resolveKey(info.apiKey) ?? '') : client);
    const allowed = [...cfg.allowedCommands, ...(projectConfig ? readProjectAllowedCommands(projectRoot) : [])];
    const permissions = new Permissions(cfg.permissionMode, allowed, req => this.askPermission(req));
    const memDir = projectConfig ? memoryDir(projectRoot) : undefined;
    const info = models.find(m => m.id === startModel);
    const agent: Agent = new Agent({
      client: clientFor(info),
      model: startModel,
      root,
      permissions,
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
      maxTurns: MAX_TURNS,
      contextWindow: info?.contextWindow,
      memoryDir: memDir,
      ask: questions => this.askQuestions(questions),
      systemPrompt: (): string => buildSystemPrompt({
        root, mode: permissions.mode, model: agent.opts.model, nonInteractive: false, projectConfig, memoryDir: memDir, host: 'vscode',
      }),
    });
    this.core = { root, cfg, models, agent, permissions, clientFor };
    if (!this.session || this.session.root !== root) {
      this.session = this.freshSession(this.core);
      this.ideContext = new IdeContext(root);
    } else {
      agent.messages = this.session.messages;
      agent.usage = this.session.usage ?? { prompt: 0, completion: 0 };
    }
    this.ideContext ??= new IdeContext(root);
    if (listError) this.post({ type: 'notice', message: `Could not list the endpoint's models: ${listError}` });
  }

  private freshSession(core: Core): SessionFile {
    const now = new Date().toISOString();
    return { id: newSessionId(), root: core.root, model: core.agent.opts.model, title: '', created: now, updated: now, messages: [], usage: { prompt: 0, completion: 0 } };
  }

  // `shown` is what the transcript shows in place of a long built-in prompt
  // ("/init"); a message sent with it is never read as a command.
  private async send(text: string, images: string[], includeEditor: boolean, shown?: string): Promise<void> {
    if (this.current) return;
    await this.ensureCore();
    const core = this.core;
    const session = this.session;
    if (!core || !session) return;
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;

    // "/name args"; "/src/app.ts is broken" is a message, not a command.
    const slash = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (slash && images.length === 0 && shown === undefined) { await this.command(slash[1].toLowerCase(), (slash[2] ?? '').trim()); return; }

    const accepted: string[] = [];
    for (const url of images) {
      const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(url);
      if (!m) { this.post({ type: 'notice', message: 'Skipped an attachment that is not a PNG, JPEG, GIF or WebP image.' }); continue; }
      if (m[2].length * 0.75 > MAX_IMAGE_BYTES) { this.post({ type: 'notice', message: `Skipped an image over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` }); continue; }
      accepted.push(url);
    }

    const fromIde = includeEditor ? this.ideContext?.forMessage(this.editorState()) ?? null : null;
    const expanded = fromIde ? `${trimmed}\n\n${fromIde.text}` : trimmed;
    const input: string | ContentPart[] = accepted.length
      ? [{ type: 'text', text: expanded }, ...accepted.map(url => ({ type: 'image_url' as const, image_url: { url } }))]
      : expanded;
    const label = shown ?? trimmed;
    if (!session.title || session.title === '(untitled)') { session.title = titleFrom(label || 'Image'); session.titleSource = 'prompt'; }
    this.post({ type: 'user', text: label, images: accepted, note: fromIde?.note ?? '' });
    this.showTitle(session.title);

    const controller = new AbortController();
    this.current = controller;
    this.post({ type: 'busy', busy: true });
    let asked: Question[] | null = null;
    try {
      const result = await core.agent.run(input, this.events(), controller.signal);
      if (result.error) this.post({ type: 'error', message: result.error });
      this.post({ type: 'done', stopped: result.stopped });
      if (!result.stopped && !result.error) this.autoName(core, session);
      // A reply that asks in prose gets the form ask_user would have shown.
      const last = core.agent.messages[core.agent.messages.length - 1];
      if (!result.stopped && !result.error && last?.role === 'assistant' && !last.tool_calls && last.content) asked = questionsInProse(last.content);
    } catch (err) {
      this.post({ type: 'error', message: describeError(err) });
      this.post({ type: 'done', stopped: false });
    } finally {
      this.current = null;
      this.settlePending();
      this.persist();
      this.post({ type: 'busy', busy: false });
      this.postState();
    }
    if (asked) {
      const answer = await this.askQuestions(asked);
      if (answer.kind !== 'answered' || answer.answers.every(a => a === undefined)) return;
      const reply = asked.length === 1
        ? answer.answers[0]!
        : asked.map((q, i) => (answer.answers[i] === undefined ? '' : `${q.question} → ${answer.answers[i]}`)).filter(Boolean).join('\n');
      await this.send(reply, [], false);
    }
  }

  // The panel's slash commands (COMMANDS): the CLI's, less the ones only a
  // terminal needs. What they report goes into the transcript as an info row.
  private async command(name: string, arg: string): Promise<void> {
    const core = this.core!;
    const agent = core.agent;
    const info = (text: string) => this.post({ type: 'info', text });
    switch (name) {
      case 'help': case '?':
        info(COMMANDS.map(c => `${c.name}${c.args ? ` ${c.args}` : ''} — ${c.about}`).join('\n'));
        return;
      case 'clear': case 'new': await this.newChat(); return;
      case 'compact': await this.compact(arg || undefined); return;
      case 'resume': case 'sessions': await this.showHistory(); return;
      case 'login': case 'signin': await this.signIn(); return;
      case 'init': await this.send(INIT_PROMPT, [], false, '/init'); return;
      case 'model': case 'models': {
        let id = arg;
        if (!id) {
          const pick = await vscode.window.showQuickPick(core.models.map(m => ({
            label: m.id, description: [m.custom ? 'custom' : '', m.id === agent.opts.model ? 'current' : ''].filter(Boolean).join(' · ') || undefined,
          })), { title: 'KEDTec: switch model' });
          if (!pick) return;
          id = pick.label;
        }
        if (!core.models.some(m => m.id === id)) { this.post({ type: 'notice', message: `No model "${id}". Type /model to pick from the list.` }); return; }
        this.setModel(id);
        info(`Model: ${id} (saved as default)`);
        return;
      }
      case 'mode': case 'plan': {
        const modes = this.modes();
        const want = name === 'plan' ? 'plan' : arg ? normalizeMode(arg) : modes[(modes.indexOf(core.permissions.mode) + 1) % modes.length];
        if (!want || !modes.includes(want)) { this.post({ type: 'notice', message: `Unknown mode "${arg}". One of: ${modes.join(', ')}.` }); return; }
        this.setMode(want);
        info(`Mode: ${want}`);
        return;
      }
      case 'memory': {
        const dir = agent.opts.memoryDir;
        if (!dir) { info('Memory is off in Restricted Mode. Trust this folder to turn it on.'); return; }
        const [sub, memName] = arg.split(/\s+/);
        if (sub === 'refresh') { await this.send(MEMORY_REFRESH_PROMPT, [], false, '/memory refresh'); return; }
        if (sub === 'forget') {
          if (!isMemoryName(memName)) { this.post({ type: 'notice', message: 'Usage: /memory forget <name> (names are listed by /memory)' }); return; }
          info(deleteMemory(dir, memName) ? `Forgot "${memName}".` : `No memory named "${memName}".`);
          return;
        }
        const all = listMemories(dir);
        info(all.length === 0
          ? `No memories yet. The agent maps the project into "${STRUCTURE_MEMORY}" on your first request; /memory refresh does it now.`
          : all.map(m => `${m.name} (${m.type}) — ${m.description}`).join('\n'));
        return;
      }
      case 'todos':
        info(agent.todos.length === 0 ? 'No todos.'
          : agent.todos.map(t => `${t.status === 'completed' ? '☒' : t.status === 'in_progress' ? '◼' : '☐'} ${t.content}`).join('\n'));
        return;
      case 'cost': case 'usage':
        info([
          `input tokens   ${agent.usage.prompt.toLocaleString()}`,
          `output tokens  ${agent.usage.completion.toLocaleString()}`,
          `last request   ${agent.lastPromptTokens.toLocaleString()} tokens of context${agent.opts.contextWindow ? ` / ${agent.opts.contextWindow.toLocaleString()}` : ''}`,
        ].join('\n'));
        return;
      case 'status': {
        const active = core.models.find(m => m.id === agent.opts.model);
        const instr = loadInstructions(core.root, vscode.workspace.isTrusted);
        info([
          `endpoint      ${active?.endpoint ?? core.cfg.endpoint}`,
          `api key       ${maskKey(active?.endpoint ? resolveKey(active.apiKey) ?? '' : core.cfg.apiKey)}`,
          `model         ${agent.opts.model}`,
          `mode          ${core.permissions.mode}`,
          `root          ${core.root}`,
          `session       ${this.session?.id ?? ''}`,
          `memory        ${agent.opts.memoryDir ? `${listMemories(agent.opts.memoryDir).length} saved (/memory)` : 'off (Restricted Mode)'}`,
          `instructions  ${instr.length ? instr.map(f => `${displayPath(f.path, core.root)}${!f.truncated ? '' : f.text ? ' (truncated)' : ' (omitted)'}`).join(', ') : 'none'}`,
        ].join('\n'));
        return;
      }
      default:
        this.post({ type: 'notice', message: `Unknown command /${name}. Type / to see the commands.` });
    }
  }

  private events(): AgentEvents {
    return {
      thinking: () => this.post({ type: 'status', label: 'Thinking…' }),
      text: delta => this.post({ type: 'text', delta }),
      reasoning: delta => this.post({ type: 'reasoning', delta }),
      toolCallStreaming: label => this.post({ type: 'status', label: label === 'Bash' ? 'Preparing command…' : `Preparing ${label.toLowerCase()}…` }),
      toolStart: (label, summary) => this.post({ type: 'toolStart', label, summary }),
      toolEnd: outcome => this.post({
        type: 'toolEnd', isError: !!outcome.isError, display: stripAnsi((outcome.display ?? (outcome.isError ? outcome.content : '')).trim()),
      }),
      status: label => this.post({ type: 'status', label }),
      assistantEnd: () => this.post({ type: 'assistantEnd' }),
      sources: (sources, research) => this.post({ type: 'sources', rows: sourceRows(sources, research) }),
      notice: message => this.post({ type: 'notice', message }),
    };
  }

  private async compact(focus?: string): Promise<void> {
    const core = this.core;
    if (!core || this.current) return;
    if (core.agent.messages.length === 0) { this.post({ type: 'notice', message: 'Nothing to compact yet.' }); return; }
    const controller = new AbortController();
    this.current = controller;
    this.post({ type: 'busy', busy: true });
    this.post({ type: 'status', label: 'Compacting the conversation…' });
    try {
      const summary = await core.agent.compact(controller.signal, focus);
      if (this.session) this.post({ type: 'reset', items: historyItems({ ...this.session, messages: core.agent.messages }, core.root) });
      this.post({ type: 'notice', message: `Compacted the conversation (${summary.length.toLocaleString()} characters of summary).` });
    } catch (err) {
      if (!controller.signal.aborted) this.post({ type: 'error', message: `Compaction failed: ${describeError(err)}` });
    } finally {
      this.current = null;
      this.persist();
      this.post({ type: 'busy', busy: false });
      this.postState();
    }
  }

  // Stop the turn, and answer whatever it is waiting on: an approval left
  // open would hold the tool, and with it the turn, forever.
  private stop(): void {
    this.current?.abort();
    this.settlePending();
  }

  private settlePending(): void {
    for (const [id, p] of this.pending) {
      if (p.kind === 'permission') p.resolve({ allow: false });
      else p.resolve({ kind: 'dismissed' });
      this.post({ type: 'settled', id });
    }
    this.pending.clear();
  }

  private askPermission(req: PermissionRequest): Promise<PermissionAnswer> {
    if (!this.view) return Promise.resolve({ allow: false, feedback: 'The KEDTec chat panel was closed.' });
    const id = this.nextId++;
    const always = req.kind === 'edit' && !req.outsideRoot
      ? 'Yes, allow all edits this session'
      : req.kind === 'command' && req.commandPrefix ? `Yes, don't ask again for "${req.commandPrefix}"` : '';
    this.view.show?.(true);
    return new Promise(resolve => {
      this.pending.set(id, { kind: 'permission', resolve });
      this.post({
        type: 'permission', id, kind: req.kind, title: req.kind === 'command' ? 'Run this command?' : req.title,
        detail: stripAnsi(req.detail ?? ''), warnings: req.warnings ?? [], always,
      });
    });
  }

  private askQuestions(questions: Question[]): Promise<QuestionAnswers> {
    if (!this.view) return Promise.resolve({ kind: 'dismissed' });
    const id = this.nextId++;
    this.view.show?.(true);
    return new Promise(resolve => {
      this.pending.set(id, { kind: 'question', resolve });
      this.post({ type: 'question', id, questions });
    });
  }

  // One try per conversation, as in the CLI: the model names it once the
  // first exchange is done, unless it was renamed.
  private autoName(core: Core, target: SessionFile): void {
    if (this.named.has(target) || target.titleSource === 'ai' || target.titleSource === 'user') return;
    this.named.add(target);
    core.agent.suggestTitle().then(title => {
      if (!title || this.session !== target || target.titleSource === 'user') return;
      target.title = title;
      target.titleSource = 'ai';
      this.showTitle(title);
      if (!this.current) this.persist();
    }, () => { /* the first-line title stays */ });
  }

  private persist(): void {
    const core = this.core;
    const session = this.session;
    if (!core || !session) return;
    session.messages = core.agent.messages;
    session.usage = core.agent.usage;
    session.model = core.agent.opts.model;
    saveSession(session);
  }

  private setMode(value: string): void {
    const core = this.core;
    const mode = value as PermissionMode;
    if (!core || !this.modes().includes(mode)) return;
    core.permissions.mode = mode;
    rememberMode(mode);
    this.postState();
  }

  // Switch, and make it the default for the next session (the CLI's /model).
  private setModel(id: string): void {
    const core = this.core;
    const info = core?.models.find(m => m.id === id);
    if (!core || !info) return;
    core.agent.opts.model = info.id;
    core.agent.opts.contextWindow = info.contextWindow;
    core.agent.opts.client = core.clientFor(info);
    try { writeStoredConfig({ ...readStoredConfig(), model: info.id }); } catch { /* still switched for this session */ }
    this.postState();
  }

  private modes(): PermissionMode[] {
    return this.core?.cfg.permissionMode === 'bypass' ? [...MODES, 'bypass'] : MODES;
  }

  // "src/app.ts:42" or "src/app.ts:42-50", as the model cites them.
  private async openFile(ref: string): Promise<void> {
    const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(ref.trim());
    if (!m || !m[1]) return;
    const root = this.core?.root ?? workspaceRoot();
    const abs = path.isAbsolute(m[1]) ? m[1] : path.join(root ?? '', m[1]);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      void vscode.window.showWarningMessage(`KEDTec: ${m[1]} does not exist in this workspace.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(abs);
    const start = m[2] ? Math.max(0, Number(m[2]) - 1) : 0;
    const end = m[3] ? Math.max(start, Number(m[3]) - 1) : start;
    const range = new vscode.Range(start, 0, end, m[3] ? Number.MAX_SAFE_INTEGER : 0);
    await vscode.window.showTextDocument(doc, { selection: m[2] ? range : undefined, preview: true, viewColumn: vscode.ViewColumn.One });
  }

  private postState(): void {
    const core = this.core;
    if (!core) return;
    const agent = core.agent;
    this.post({
      type: 'state',
      model: agent.opts.model,
      models: core.models.map(m => ({ id: m.id, label: m.custom ? `${m.id} (custom)` : m.id })),
      mode: core.permissions.mode,
      modes: this.modes(),
      busy: !!this.current,
      used: agent.lastPromptTokens,
      contextWindow: agent.opts.contextWindow ?? 0,
      restricted: !vscode.workspace.isTrusted,
      commands: COMMANDS,
      root: core.root,
    });
  }

  // The conversation's title, beside "Chat" in the view's header.
  private showTitle(title: string): void {
    if (this.view) this.view.description = title && title !== '(untitled)' ? title : undefined;
  }

  private post(msg: Record<string, unknown>): void {
    void this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>KEDTec</title>
</head>
<body>
<main id="log" aria-live="polite"></main>
<footer>
  <div id="status" hidden><span class="spinner"></span><span id="status-label">Thinking…</span><span id="status-time"></span></div>
  <div id="attachments"></div>
  <div id="suggest" role="listbox" hidden></div>
  <div class="composer">
    <textarea id="input" rows="1" placeholder="Ask KEDTec to read, explain or change code…"></textarea>
    <button id="send" title="Send (Enter)">Send</button>
  </div>
  <div class="bar">
    <select id="mode" title="Permission mode"></select>
    <select id="model" title="Model"></select>
    <button id="context" class="chip" title="Send the open file or selection with the next message (click to turn off)"></button>
    <span id="usage"></span>
  </div>
</footer>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

// The workspace folder holding the active file, else the first one.
function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const active = vscode.window.activeTextEditor?.document.uri;
  const owner = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
  const folder = owner ?? folders[0];
  return folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

// A saved conversation as the panel draws it: the user's words without the
// editor context appended to them, each tool call as its row, and nothing of
// the plumbing (continuation nudges, tool results the person never read).
export function historyItems(session: SessionFile, root: string): HistoryItem[] {
  const items: HistoryItem[] = [];
  const failed = new Set<string>();
  for (const m of session.messages) if (m.role === 'tool' && m.content.startsWith('Error:')) failed.add(m.tool_call_id);
  for (const m of session.messages) {
    if (m.role === 'user') {
      const text = contentText(m.content).replace(/\[image\]/g, '');
      if (text.startsWith('Your reply was cut off by the output limit.')) continue;
      if (text.startsWith('This conversation was compacted.')) { items.push({ type: 'notice', message: 'Earlier messages were compacted into a summary.' }); continue; }
      const images = Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0;
      items.push({ type: 'user', text: text.replace(/\n\n<ide_(?:selection|opened_file)[\s\S]*$/, '').trim(), images });
    } else if (m.role === 'assistant') {
      if (m.content?.trim() && !m.content.startsWith('Understood — continuing from that summary.')) items.push({ type: 'assistant', text: m.content });
      for (const call of m.tool_calls ?? []) {
        const tool = findTool(call.function.name);
        let summary = '';
        try { summary = tool ? tool.summary(JSON.parse(call.function.arguments || '{}'), root) : ''; } catch { /* cut-off arguments */ }
        items.push({ type: 'tool', label: tool?.label ?? call.function.name, summary: stripAnsi(summary), isError: failed.has(call.id) });
      }
    }
  }
  return items;
}
