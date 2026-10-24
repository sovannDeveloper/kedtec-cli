#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { Agent, AgentEvents } from './agent';
import { ModelInfo, createClient, describeError, listModels, mergeCustomModels } from './client';
import {
  CONFIG_FILE, ConfigOverrides, DEFAULT_ENDPOINT, PERMISSION_MODES, PermissionMode, StoredConfig,
  maskKey, normalizeMode, readProjectAllowedCommands, readStoredConfig, removeCustomModel, resolveConfig, resolveKey,
  saveCustomModel, writeStoredConfig,
} from './config';
import { LineInput, select } from './input';
import { memoryDir } from './memory';
import { Permissions } from './permissions';
import { buildSystemPrompt, findGitRoot } from './prompt';
import { TerminalRenderer } from './render';
import { VERSION, askCustomModel, customTag, runRepl } from './repl';
import { SessionFile, deleteSession, listSessions, loadSession, newSessionId, saveSession, titleFrom } from './session';
import { confirmTrust } from './trust';
import { c, clip, setColor } from './ui';

const USAGE = `${c.bold('kedtec')} — KEDTec coding agent for the terminal

${c.bold('Usage')}
  kedtec [prompt]                  start an interactive session (optionally with a first message)
  kedtec -p "prompt"               run once and print the answer (CI / scripts); stdin is appended
  kedtec login                     set the endpoint, API key and default model
  kedtec models                    list the models the endpoint serves, and custom ones
  kedtec models add | remove <id>  add a custom model (any OpenAI-compatible endpoint), or remove one
  kedtec config [set|unset] …      show or change settings (${CONFIG_FILE})
  kedtec sessions                  list saved conversations for this directory
  kedtec sessions rm <id>          delete one of them
  kedtec sessions clear            delete all of them

${c.bold('Options')}
  -p, --print                      non-interactive: answer, then exit
  -m, --model <id>                 model to use (default: config, else the endpoint's first)
      --endpoint <url>             OpenAI-compatible base URL, e.g. http://host:3000/v1
      --permission-mode <mode>     ${PERMISSION_MODES.join(' | ')}
      --dangerously-skip-permissions   same as --permission-mode bypass
  -c, --continue                   continue the most recent conversation in this directory
  -r, --resume <id>                continue a specific conversation
      --max-turns <n>              cap on model round trips per message (default 100)
      --max-tokens <n>             cap on each reply's length
      --output-format <fmt>        print mode: text (default) | json
      --cwd <dir>                  project root (default: current directory)
      --no-project-config          ignore the project's KEDTEC.md / CLAUDE.md / AGENTS.md and
                                   .kedtec/settings.json (an untrusted checkout, e.g. CI on a PR)
      --verbose                    print mode: show tool activity and reasoning on stderr
      --no-color                   plain output
  -v, --version · -h, --help

${c.bold('Environment')}
  KEDTEC_API_KEY, KEDTEC_ENDPOINT, KEDTEC_MODEL, KEDTEC_PERMISSION_MODE,
  KEDTEC_MAX_TOKENS, KEDTEC_HOME — override the config file (handy in CI secrets).

${c.bold('Examples')}
  kedtec "explain the auth flow"
  kedtec -p "fix the failing test" --permission-mode auto
  git diff origin/main | kedtec -p "review this diff" --permission-mode plan --output-format json
`;

interface Args {
  positional: string[];
  print: boolean;
  model?: string;
  endpoint?: string;
  mode?: PermissionMode;
  cont: boolean;
  resume?: string;
  maxTurns: number;
  maxTokens?: number;
  outputFormat: 'text' | 'json';
  cwd?: string;
  verbose: boolean;
  projectConfig: boolean;
}

function die(message: string, code = 1): never {
  process.stderr.write(`${c.red('error:')} ${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  const a: Args = { positional: [], print: false, cont: false, maxTurns: 100, outputFormat: 'text', verbose: false, projectConfig: true };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('-') && v.length > 1)) die(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const take = () => (inline !== undefined ? inline : value(i++, flag));
    switch (flag) {
      case '-h': case '--help': process.stdout.write(USAGE); process.exit(0);
      // eslint-disable-next-line no-fallthrough
      case '-v': case '--version': process.stdout.write(`${VERSION}\n`); process.exit(0);
      // eslint-disable-next-line no-fallthrough
      case '-p': case '--print': a.print = true; break;
      case '-m': case '--model': a.model = take(); break;
      case '--endpoint': case '--base-url': a.endpoint = take(); break;
      case '--permission-mode': {
        const raw = take();
        const mode = normalizeMode(raw);
        if (!mode) die(`unknown permission mode "${raw}" (${PERMISSION_MODES.join(', ')})`);
        a.mode = mode;
        break;
      }
      case '--dangerously-skip-permissions': a.mode = 'bypass'; break;
      case '-c': case '--continue': a.cont = true; break;
      case '-r': case '--resume': a.resume = take(); break;
      case '--max-turns': a.maxTurns = Math.max(1, Math.floor(Number(take())) || 100); break;
      case '--max-tokens': a.maxTokens = Math.floor(Number(take())) || undefined; break;
      case '--output-format': {
        const f = take();
        if (f !== 'text' && f !== 'json') die('--output-format is text or json');
        a.outputFormat = f;
        break;
      }
      case '--cwd': a.cwd = take(); break;
      case '--verbose': a.verbose = true; break;
      case '--no-project-config': a.projectConfig = false; break;
      case '--no-color': setColor(false); break;
      default:
        if (arg.startsWith('-') && arg.length > 1 && arg !== '-') die(`unknown option ${arg} (see --help)`);
        a.positional.push(arg);
    }
  }
  return a;
}

// Piped input (`git diff | kedtec -p "review"`). Many CI runners hand the
// process an open stdin pipe that never closes, so when a prompt was given on
// the command line, stdin is read only if data starts arriving promptly —
// otherwise waiting for its EOF would hang the job forever.
function readStdin(havePrompt: boolean): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (d: Buffer) => { chunks.push(d); clearTimeout(idle); };
    const idle = setTimeout(() => { if (havePrompt && chunks.length === 0) finish(); }, 300);
    process.stdin.on('data', onData);
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
    process.stdin.resume();
  });
}

// ── subcommands ──────────────────────────────────────────────────────────────

async function cmdLogin(): Promise<void> {
  if (!process.stdin.isTTY) die('login is interactive; in CI set KEDTEC_API_KEY / KEDTEC_ENDPOINT instead.');
  const input = new LineInput();
  const stored = readStoredConfig();
  const ep = await input.ask(`Endpoint ${c.gray(`[${stored.endpoint ?? DEFAULT_ENDPOINT}]`)}: `, { history: false, multiline: false });
  if (ep.kind !== 'line') process.exit(130);
  const endpoint = (ep.text.trim() || stored.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const key = await input.ask(`API key ${c.gray(stored.apiKey ? `[keep ${maskKey(stored.apiKey)}]` : '(from /admin/tokens)')}: `, { history: false, multiline: false, secret: true });
  if (key.kind !== 'line') process.exit(130);
  const apiKey = key.text.trim() || stored.apiKey || '';
  let models: ModelInfo[] = [];
  try {
    models = await listModels(endpoint, apiKey);
    console.log(c.green(`✓ Connected — ${models.length} model${models.length === 1 ? '' : 's'} available.`));
  } catch (err) {
    console.log(c.yellow(`! Could not list models: ${describeError(err)}`));
  }
  let model = stored.model;
  if (models.length > 0) {
    const choice = await select(models.map(m => m.id), Math.max(0, models.findIndex(m => m.id === stored.model)),
      { title: 'Default model (enter selects):', transient: true });
    if (choice !== null) model = models[choice].id;
    if (model) console.log(`Default model: ${c.bold(model)}`);
  }
  writeStoredConfig({ ...stored, endpoint, apiKey, model });
  console.log(c.gray(`Saved to ${CONFIG_FILE}`));
}

function cmdConfig(rest: string[]): void {
  const [action, key, ...valueParts] = rest;
  const stored = readStoredConfig();
  const keys: (keyof StoredConfig)[] = ['endpoint', 'apiKey', 'model', 'maxTokens', 'temperature', 'permissionMode', 'allowedCommands'];
  if (!action || action === 'show' || action === 'list') {
    const r = resolveConfig();
    console.log([
      `${c.gray('file           ')} ${CONFIG_FILE}`,
      `${c.gray('endpoint       ')} ${r.endpoint}`,
      `${c.gray('apiKey         ')} ${maskKey(r.apiKey)}`,
      `${c.gray('model          ')} ${r.model || '(endpoint default)'}`,
      `${c.gray('maxTokens      ')} ${r.maxTokens}`,
      `${c.gray('temperature    ')} ${r.temperature}`,
      `${c.gray('permissionMode ')} ${r.permissionMode}`,
      `${c.gray('allowedCommands')} ${r.allowedCommands.length ? r.allowedCommands.join(', ') : '(none)'}`,
      `${c.gray('customModels   ')} ${r.customModels.length ? r.customModels.map(m => `${m.id}${m.endpoint ? ` (${m.endpoint})` : ''}`).join(', ') : '(none — kedtec models add)'}`,
    ].join('\n'));
    return;
  }
  if (!key || !keys.includes(key as keyof StoredConfig)) die(`config ${action} <key>: one of ${keys.join(', ')}`);
  const k = key as keyof StoredConfig;
  if (action === 'unset') {
    delete stored[k];
  } else if (action === 'set') {
    const value = valueParts.join(' ');
    if (!value) die(`config set ${key} <value>`);
    if (k === 'maxTokens' || k === 'temperature') {
      const n = Number(value);
      if (!Number.isFinite(n)) die(`${key} must be a number`);
      (stored as Record<string, unknown>)[k] = n;
    } else if (k === 'permissionMode') {
      const m = normalizeMode(value);
      if (!m) die(`permissionMode is one of ${PERMISSION_MODES.join(', ')}`);
      stored.permissionMode = m;
    } else if (k === 'allowedCommands') {
      stored.allowedCommands = value.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      (stored as Record<string, unknown>)[k] = k === 'endpoint' ? value.replace(/\/+$/, '') : value;
    }
  } else die(`unknown config action "${action}" (show, set, unset)`);
  writeStoredConfig(stored);
  console.log(c.gray(`Saved ${key}.`));
}

async function cmdModels(overrides: ConfigOverrides): Promise<void> {
  const cfg = resolveConfig(overrides);
  let listed: ModelInfo[] = [];
  try { listed = await listModels(cfg.endpoint, cfg.apiKey); } catch (err) {
    if (cfg.customModels.length === 0) die(describeError(err));
    console.log(c.yellow(`! Could not list the endpoint's models: ${describeError(err)}`));
  }
  const models = mergeCustomModels(listed, cfg.customModels);
  if (models.length === 0) console.log(c.gray('The endpoint lists no models. Add one with `kedtec models add`.'));
  for (const m of models) {
    const cw = m.contextWindow ? c.gray(` · ${m.contextWindow.toLocaleString()} ctx`) : '';
    console.log(`${m.id === cfg.model ? c.accent('●') : ' '} ${m.id}${m.name !== m.id ? c.gray(`  ${m.name}`) : ''}${cw}${customTag(m)}`);
  }
}

async function cmdModelsAdd(overrides: ConfigOverrides): Promise<void> {
  if (!process.stdin.isTTY) die('models add is interactive; edit customModels in the config file instead.');
  const cfg = resolveConfig(overrides);
  const model = await askCustomModel(new LineInput(), cfg);
  if (!model) process.exit(130);
  saveCustomModel(model);
  console.log(c.gray(`Saved ${model.id} to ${CONFIG_FILE}. Use it with: kedtec -m ${model.id}  (or /model in a session)`));
}

function cmdModelsRemove(id: string | undefined): void {
  if (!id) die('models remove <id>');
  if (!removeCustomModel(id)) die(`no custom model "${id}" (kedtec models lists them)`);
  console.log(c.gray(`Removed ${id}.`));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const overrides: ConfigOverrides = { endpoint: args.endpoint, model: args.model, permissionMode: args.mode, maxTokens: args.maxTokens };

  const sub = args.positional[0];
  if (!args.print && args.positional.length >= 1) {
    if (sub === 'login') return cmdLogin();
    if (sub === 'logout') { const s = readStoredConfig(); delete s.apiKey; writeStoredConfig(s); console.log('API key removed.'); return; }
    if (sub === 'config') return cmdConfig(args.positional.slice(1));
    if (sub === 'models' && args.positional[1] === 'add') return cmdModelsAdd(overrides);
    if (sub === 'models' && (args.positional[1] === 'remove' || args.positional[1] === 'rm')) return cmdModelsRemove(args.positional[2]);
    if (sub === 'models') return cmdModels(overrides);
  }

  const root = path.resolve(args.cwd ?? process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`not a directory: ${root}`);

  if (!args.print && sub === 'sessions') {
    const op = args.positional[1];
    const sessions = listSessions(root);
    const plural = (n: number) => `${n} conversation${n === 1 ? '' : 's'}`;
    if (op === 'rm' || op === 'delete') {
      const id = args.positional[2];
      if (!id) die('usage: kedtec sessions rm <id>  (ids are listed by kedtec sessions)');
      const matches = sessions.filter(s => s.id === id || s.id.startsWith(id));
      if (matches.length !== 1) die(matches.length ? `"${id}" matches ${matches.length} conversations; give more of the id` : `no saved conversation "${id}" in this directory`);
      if (!deleteSession(matches[0])) die(`could not delete "${matches[0].id}"`);
      console.log(`Deleted "${matches[0].title}" (${matches[0].id}).`);
      return;
    }
    if (op === 'clear') {
      if (sessions.length === 0) { console.log(c.gray('No saved conversations for this directory.')); return; }
      if (!process.stdin.isTTY) die('kedtec sessions clear asks for confirmation, so it needs a terminal');
      const sure = await select(['No, keep them', `Yes, delete ${plural(sessions.length)}`], 0,
        { title: c.yellow(`Delete this directory's ${plural(sessions.length)}? It cannot be undone.`) });
      if (sure !== 1) return;
      console.log(`Deleted ${sessions.filter(deleteSession).length} of ${plural(sessions.length)}.`);
      return;
    }
    if (op) die(`unknown "sessions ${op}"; use kedtec sessions, kedtec sessions rm <id> or kedtec sessions clear`);
    if (sessions.length === 0) console.log(c.gray('No saved conversations for this directory.'));
    for (const s of sessions) console.log(`${c.accent(s.id)}  ${clip(s.title, 50)}  ${c.gray(`${s.updated.slice(0, 16).replace('T', ' ')} · ${s.messages.length} msgs`)}`);
    return;
  }

  const cfg = resolveConfig(overrides);
  let prompt = args.positional.join(' ').trim();
  const piped = await readStdin(!!prompt);
  // No terminal to talk to means print mode, whether or not -p was given.
  const printMode = args.print || !process.stdin.isTTY || !process.stdout.isTTY;
  if (piped.trim()) prompt = prompt ? `${prompt}\n\n<stdin>\n${piped.trimEnd()}\n</stdin>` : piped.trim();

  // Asked before anything reads the project (its .kedtec/settings.json can
  // pre-approve commands). Print mode never asks: a CI job has nobody to answer,
  // and choosing to run it there is the decision.
  if (!printMode && !(await confirmTrust(root))) process.exit(1);

  if (!cfg.apiKey && cfg.endpoint === DEFAULT_ENDPOINT && !printMode) {
    console.log(c.yellow('No API key configured. Run `kedtec login` (or set KEDTEC_API_KEY).'));
  }

  // The model: flag/env/config, else the endpoint's first entry — which on the
  // KEDTec API is the registry's default model — else the first custom one.
  let listed: ModelInfo[] = [];
  let listError = '';
  try { listed = await listModels(cfg.endpoint, cfg.apiKey); } catch (err) { listError = describeError(err); }
  const models = mergeCustomModels(listed, cfg.customModels);
  const startModel = cfg.model || listed[0]?.id || models[0]?.id;
  if (!startModel) {
    die(listError
      ? `no model configured and the model list could not be read: ${listError}`
      : 'the endpoint lists no models; pass --model <id>, or add one with `kedtec models add`');
  }

  const client = createClient(cfg.endpoint, cfg.apiKey);
  // A custom model served elsewhere gets a client of its own.
  const clientFor = (info: ModelInfo | undefined) => (info?.endpoint ? createClient(info.endpoint, resolveKey(info.apiKey) ?? '') : client);
  const projectAllowed = args.projectConfig ? readProjectAllowedCommands(findGitRoot(root) ?? root) : [];
  const permissions = new Permissions(cfg.permissionMode, [...cfg.allowedCommands, ...projectAllowed], null);
  // Off with --no-project-config, like the project's instruction files.
  const memDir = args.projectConfig ? memoryDir(findGitRoot(root) ?? root) : undefined;

  let session: SessionFile = {
    id: newSessionId(), root, model: startModel, title: '', created: new Date().toISOString(), updated: new Date().toISOString(),
    messages: [], usage: { prompt: 0, completion: 0 },
  };
  if (args.cont || args.resume) {
    const found = loadSession(root, args.resume);
    if (!found) die(args.resume ? `no saved conversation "${args.resume}" in this directory` : 'no saved conversation in this directory to continue');
    session = found;
  }

  const agent: Agent = new Agent({
    client: clientFor(models.find(m => m.id === startModel)),
    model: startModel,
    root,
    permissions,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    maxTurns: args.maxTurns,
    contextWindow: models.find(m => m.id === startModel)?.contextWindow,
    memoryDir: memDir,
    systemPrompt: (): string => buildSystemPrompt({
      root, mode: permissions.mode, model: agent.opts.model, nonInteractive: printMode, projectConfig: args.projectConfig, memoryDir: memDir,
    }),
  });
  agent.messages = session.messages;
  agent.usage = session.usage ?? { prompt: 0, completion: 0 };

  const setModel = (m: ModelInfo | string) => {
    const info = typeof m === 'string' ? models.find(x => x.id === m) : m;
    agent.opts.model = typeof m === 'string' ? m : m.id;
    agent.opts.contextWindow = info?.contextWindow;
    agent.opts.client = clientFor(info);
  };

  if (!printMode) {
    await runRepl({
      config: cfg, client, root, models, agent, permissions, session, initialPrompt: prompt || undefined, setModel, projectConfig: args.projectConfig,
    });
    return;
  }

  // ── print mode ──
  if (!prompt) die('print mode needs a prompt (an argument or stdin)');
  if (!session.title) session.title = titleFrom(prompt);
  // stdout carries only the answer; with --verbose the activity goes to stderr.
  const renderer = new TerminalRenderer(process.stderr, { showText: args.verbose, showReasoning: args.verbose, spinner: false });
  const events: AgentEvents = args.verbose ? renderer : {
    thinking() {}, text() {}, reasoning() {}, toolCallStreaming() {}, toolStart() {}, toolEnd() {}, status() {}, assistantEnd() {}, sources() {},
    notice: m => { process.stderr.write(`${c.yellow('!')} ${m}\n`); },
  };
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  const result = await agent.run(prompt, events, controller.signal);
  session.messages = agent.messages;
  session.usage = agent.usage;
  saveSession(session);

  const isError = !!result.error || result.stopped;
  if (args.outputFormat === 'json') {
    process.stdout.write(JSON.stringify({
      type: 'result',
      is_error: isError,
      result: result.text,
      error: result.error ?? (result.stopped ? 'interrupted' : undefined),
      turns: result.turns,
      model: agent.opts.model,
      session_id: session.id,
      usage: { input_tokens: agent.usage.prompt, output_tokens: agent.usage.completion },
    }) + '\n');
  } else {
    if (result.text) process.stdout.write(result.text.trimEnd() + '\n');
    if (result.error) process.stderr.write(`${c.red('error:')} ${result.error}\n`);
  }
  process.exit(result.stopped ? 130 : isError ? 1 : 0);
}

main().catch(err => die(describeError(err)));
