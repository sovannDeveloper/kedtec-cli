#!/usr/bin/env node
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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const agent_1 = require("./agent");
const client_1 = require("./client");
const config_1 = require("./config");
const input_1 = require("./input");
const permissions_1 = require("./permissions");
const prompt_1 = require("./prompt");
const render_1 = require("./render");
const repl_1 = require("./repl");
const session_1 = require("./session");
const trust_1 = require("./trust");
const ui_1 = require("./ui");
const USAGE = `${ui_1.c.bold('kedtec')} — KEDTec coding agent for the terminal

${ui_1.c.bold('Usage')}
  kedtec [prompt]                  start an interactive session (optionally with a first message)
  kedtec -p "prompt"               run once and print the answer (CI / scripts); stdin is appended
  kedtec login                     set the endpoint, API key and default model
  kedtec models                    list the models the endpoint serves
  kedtec config [set|unset] …      show or change settings (${config_1.CONFIG_FILE})
  kedtec sessions                  list saved conversations for this directory

${ui_1.c.bold('Options')}
  -p, --print                      non-interactive: answer, then exit
  -m, --model <id>                 model to use (default: config, else the endpoint's first)
      --endpoint <url>             OpenAI-compatible base URL, e.g. http://host:3000/v1
      --permission-mode <mode>     ${config_1.PERMISSION_MODES.join(' | ')}
      --dangerously-skip-permissions   same as --permission-mode bypass
  -c, --continue                   continue the most recent conversation in this directory
  -r, --resume <id>                continue a specific conversation
      --max-turns <n>              cap on model round trips per message (default 100)
      --max-tokens <n>             cap on each reply's length
      --output-format <fmt>        print mode: text (default) | json
      --cwd <dir>                  project root (default: current directory)
      --verbose                    print mode: show tool activity and reasoning on stderr
      --no-color                   plain output
  -v, --version · -h, --help

${ui_1.c.bold('Environment')}
  KEDTEC_API_KEY, KEDTEC_ENDPOINT, KEDTEC_MODEL, KEDTEC_PERMISSION_MODE,
  KEDTEC_MAX_TOKENS, KEDTEC_HOME — override the config file (handy in CI secrets).

${ui_1.c.bold('Examples')}
  kedtec "explain the auth flow"
  kedtec -p "fix the failing test" --permission-mode auto
  git diff origin/main | kedtec -p "review this diff" --permission-mode plan --output-format json
`;
function die(message, code = 1) {
    process.stderr.write(`${ui_1.c.red('error:')} ${message}\n`);
    process.exit(code);
}
function parseArgs(argv) {
    const a = { positional: [], print: false, cont: false, maxTurns: 100, outputFormat: 'text', verbose: false };
    const value = (i, flag) => {
        const v = argv[i + 1];
        if (v === undefined || (v.startsWith('-') && v.length > 1))
            die(`${flag} needs a value`);
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
        const take = () => (inline !== undefined ? inline : value(i++, flag));
        switch (flag) {
            case '-h':
            case '--help':
                process.stdout.write(USAGE);
                process.exit(0);
            // eslint-disable-next-line no-fallthrough
            case '-v':
            case '--version':
                process.stdout.write(`${repl_1.VERSION}\n`);
                process.exit(0);
            // eslint-disable-next-line no-fallthrough
            case '-p':
            case '--print':
                a.print = true;
                break;
            case '-m':
            case '--model':
                a.model = take();
                break;
            case '--endpoint':
            case '--base-url':
                a.endpoint = take();
                break;
            case '--permission-mode': {
                const raw = take();
                const mode = (0, config_1.normalizeMode)(raw);
                if (!mode)
                    die(`unknown permission mode "${raw}" (${config_1.PERMISSION_MODES.join(', ')})`);
                a.mode = mode;
                break;
            }
            case '--dangerously-skip-permissions':
                a.mode = 'bypass';
                break;
            case '-c':
            case '--continue':
                a.cont = true;
                break;
            case '-r':
            case '--resume':
                a.resume = take();
                break;
            case '--max-turns':
                a.maxTurns = Math.max(1, Math.floor(Number(take())) || 100);
                break;
            case '--max-tokens':
                a.maxTokens = Math.floor(Number(take())) || undefined;
                break;
            case '--output-format': {
                const f = take();
                if (f !== 'text' && f !== 'json')
                    die('--output-format is text or json');
                a.outputFormat = f;
                break;
            }
            case '--cwd':
                a.cwd = take();
                break;
            case '--verbose':
                a.verbose = true;
                break;
            case '--no-color':
                (0, ui_1.setColor)(false);
                break;
            default:
                if (arg.startsWith('-') && arg.length > 1 && arg !== '-')
                    die(`unknown option ${arg} (see --help)`);
                a.positional.push(arg);
        }
    }
    return a;
}
// Piped input (`git diff | kedtec -p "review"`). Many CI runners hand the
// process an open stdin pipe that never closes, so when a prompt was given on
// the command line, stdin is read only if data starts arriving promptly —
// otherwise waiting for its EOF would hang the job forever.
function readStdin(havePrompt) {
    if (process.stdin.isTTY)
        return Promise.resolve('');
    return new Promise(resolve => {
        const chunks = [];
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(idle);
            process.stdin.off('data', onData);
            process.stdin.pause();
            resolve(Buffer.concat(chunks).toString('utf8'));
        };
        const onData = (d) => { chunks.push(d); clearTimeout(idle); };
        const idle = setTimeout(() => { if (havePrompt && chunks.length === 0)
            finish(); }, 300);
        process.stdin.on('data', onData);
        process.stdin.once('end', finish);
        process.stdin.once('error', finish);
        process.stdin.resume();
    });
}
// ── subcommands ──────────────────────────────────────────────────────────────
async function cmdLogin() {
    if (!process.stdin.isTTY)
        die('login is interactive; in CI set KEDTEC_API_KEY / KEDTEC_ENDPOINT instead.');
    const input = new input_1.LineInput();
    const stored = (0, config_1.readStoredConfig)();
    const ep = await input.ask(`Endpoint ${ui_1.c.gray(`[${stored.endpoint ?? config_1.DEFAULT_ENDPOINT}]`)}: `, { history: false, multiline: false });
    if (ep.kind !== 'line')
        process.exit(130);
    const endpoint = (ep.text.trim() || stored.endpoint || config_1.DEFAULT_ENDPOINT).replace(/\/+$/, '');
    const key = await input.ask(`API key ${ui_1.c.gray(stored.apiKey ? `[keep ${(0, config_1.maskKey)(stored.apiKey)}]` : '(from /admin/tokens)')}: `, { history: false, multiline: false, secret: true });
    if (key.kind !== 'line')
        process.exit(130);
    const apiKey = key.text.trim() || stored.apiKey || '';
    let models = [];
    try {
        models = await (0, client_1.listModels)(endpoint, apiKey);
        console.log(ui_1.c.green(`✓ Connected — ${models.length} model${models.length === 1 ? '' : 's'} available.`));
    }
    catch (err) {
        console.log(ui_1.c.yellow(`! Could not list models: ${(0, client_1.describeError)(err)}`));
    }
    let model = stored.model;
    if (models.length > 0) {
        console.log('Default model (enter selects):');
        const choice = await (0, input_1.select)(models.map(m => m.id), Math.max(0, models.findIndex(m => m.id === stored.model)));
        if (choice !== null)
            model = models[choice].id;
    }
    (0, config_1.writeStoredConfig)({ ...stored, endpoint, apiKey, model });
    console.log(ui_1.c.gray(`Saved to ${config_1.CONFIG_FILE}`));
}
function cmdConfig(rest) {
    const [action, key, ...valueParts] = rest;
    const stored = (0, config_1.readStoredConfig)();
    const keys = ['endpoint', 'apiKey', 'model', 'maxTokens', 'temperature', 'permissionMode', 'allowedCommands'];
    if (!action || action === 'show' || action === 'list') {
        const r = (0, config_1.resolveConfig)();
        console.log([
            `${ui_1.c.gray('file           ')} ${config_1.CONFIG_FILE}`,
            `${ui_1.c.gray('endpoint       ')} ${r.endpoint}`,
            `${ui_1.c.gray('apiKey         ')} ${(0, config_1.maskKey)(r.apiKey)}`,
            `${ui_1.c.gray('model          ')} ${r.model || '(endpoint default)'}`,
            `${ui_1.c.gray('maxTokens      ')} ${r.maxTokens}`,
            `${ui_1.c.gray('temperature    ')} ${r.temperature}`,
            `${ui_1.c.gray('permissionMode ')} ${r.permissionMode}`,
            `${ui_1.c.gray('allowedCommands')} ${r.allowedCommands.length ? r.allowedCommands.join(', ') : '(none)'}`,
        ].join('\n'));
        return;
    }
    if (!key || !keys.includes(key))
        die(`config ${action} <key>: one of ${keys.join(', ')}`);
    const k = key;
    if (action === 'unset') {
        delete stored[k];
    }
    else if (action === 'set') {
        const value = valueParts.join(' ');
        if (!value)
            die(`config set ${key} <value>`);
        if (k === 'maxTokens' || k === 'temperature') {
            const n = Number(value);
            if (!Number.isFinite(n))
                die(`${key} must be a number`);
            stored[k] = n;
        }
        else if (k === 'permissionMode') {
            const m = (0, config_1.normalizeMode)(value);
            if (!m)
                die(`permissionMode is one of ${config_1.PERMISSION_MODES.join(', ')}`);
            stored.permissionMode = m;
        }
        else if (k === 'allowedCommands') {
            stored.allowedCommands = value.split(',').map(s => s.trim()).filter(Boolean);
        }
        else {
            stored[k] = k === 'endpoint' ? value.replace(/\/+$/, '') : value;
        }
    }
    else
        die(`unknown config action "${action}" (show, set, unset)`);
    (0, config_1.writeStoredConfig)(stored);
    console.log(ui_1.c.gray(`Saved ${key}.`));
}
async function cmdModels(overrides) {
    const cfg = (0, config_1.resolveConfig)(overrides);
    try {
        const models = await (0, client_1.listModels)(cfg.endpoint, cfg.apiKey);
        if (models.length === 0)
            console.log(ui_1.c.gray('The endpoint lists no models.'));
        for (const m of models) {
            const cw = m.contextWindow ? ui_1.c.gray(` · ${m.contextWindow.toLocaleString()} ctx`) : '';
            console.log(`${m.id === cfg.model ? ui_1.c.accent('●') : ' '} ${m.id}${m.name !== m.id ? ui_1.c.gray(`  ${m.name}`) : ''}${cw}`);
        }
    }
    catch (err) {
        die((0, client_1.describeError)(err));
    }
}
// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const overrides = { endpoint: args.endpoint, model: args.model, permissionMode: args.mode, maxTokens: args.maxTokens };
    const sub = args.positional[0];
    if (!args.print && args.positional.length >= 1) {
        if (sub === 'login')
            return cmdLogin();
        if (sub === 'logout') {
            const s = (0, config_1.readStoredConfig)();
            delete s.apiKey;
            (0, config_1.writeStoredConfig)(s);
            console.log('API key removed.');
            return;
        }
        if (sub === 'config')
            return cmdConfig(args.positional.slice(1));
        if (sub === 'models')
            return cmdModels(overrides);
    }
    const root = path.resolve(args.cwd ?? process.cwd());
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
        die(`not a directory: ${root}`);
    if (!args.print && sub === 'sessions') {
        const sessions = (0, session_1.listSessions)(root);
        if (sessions.length === 0)
            console.log(ui_1.c.gray('No saved conversations for this directory.'));
        for (const s of sessions.slice(0, 30))
            console.log(`${ui_1.c.accent(s.id)}  ${(0, ui_1.clip)(s.title, 50)}  ${ui_1.c.gray(`${s.updated.slice(0, 16).replace('T', ' ')} · ${s.messages.length} msgs`)}`);
        return;
    }
    const cfg = (0, config_1.resolveConfig)(overrides);
    let prompt = args.positional.join(' ').trim();
    const piped = await readStdin(!!prompt);
    // No terminal to talk to means print mode, whether or not -p was given.
    const printMode = args.print || !process.stdin.isTTY || !process.stdout.isTTY;
    if (piped.trim())
        prompt = prompt ? `${prompt}\n\n<stdin>\n${piped.trimEnd()}\n</stdin>` : piped.trim();
    // Asked before anything reads the project (its .kedtec/settings.json can
    // pre-approve commands). Print mode never asks: a CI job has nobody to answer,
    // and choosing to run it there is the decision.
    if (!printMode && !(await (0, trust_1.confirmTrust)(root)))
        process.exit(1);
    if (!cfg.apiKey && cfg.endpoint === config_1.DEFAULT_ENDPOINT && !printMode) {
        console.log(ui_1.c.yellow('No API key configured. Run `kedtec login` (or set KEDTEC_API_KEY).'));
    }
    // The model: flag/env/config, else the endpoint's first entry — which on the
    // KEDTec API is the registry's default model.
    let models = [];
    try {
        models = await (0, client_1.listModels)(cfg.endpoint, cfg.apiKey);
    }
    catch (err) {
        if (!cfg.model)
            die(`no model configured and the model list could not be read: ${(0, client_1.describeError)(err)}`);
    }
    const startModel = cfg.model || models[0]?.id;
    if (!startModel)
        die('the endpoint lists no models; pass --model <id>');
    const client = (0, client_1.createClient)(cfg.endpoint, cfg.apiKey);
    const permissions = new permissions_1.Permissions(cfg.permissionMode, [...cfg.allowedCommands, ...(0, config_1.readProjectAllowedCommands)((0, prompt_1.findGitRoot)(root) ?? root)], null);
    let session = {
        id: (0, session_1.newSessionId)(), root, model: startModel, title: '', created: new Date().toISOString(), updated: new Date().toISOString(),
        messages: [], usage: { prompt: 0, completion: 0 },
    };
    if (args.cont || args.resume) {
        const found = (0, session_1.loadSession)(root, args.resume);
        if (!found)
            die(args.resume ? `no saved conversation "${args.resume}" in this directory` : 'no saved conversation in this directory to continue');
        session = found;
    }
    const agent = new agent_1.Agent({
        client,
        model: startModel,
        root,
        permissions,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        maxTurns: args.maxTurns,
        contextWindow: models.find(m => m.id === startModel)?.contextWindow,
        systemPrompt: () => (0, prompt_1.buildSystemPrompt)({ root, mode: permissions.mode, model: agent.opts.model, nonInteractive: printMode }),
    });
    agent.messages = session.messages;
    agent.usage = session.usage ?? { prompt: 0, completion: 0 };
    const setModel = (m) => {
        const info = typeof m === 'string' ? models.find(x => x.id === m) : m;
        agent.opts.model = typeof m === 'string' ? m : m.id;
        agent.opts.contextWindow = info?.contextWindow;
    };
    if (!printMode) {
        await (0, repl_1.runRepl)({ config: cfg, client, root, models, agent, permissions, session, initialPrompt: prompt || undefined, setModel });
        return;
    }
    // ── print mode ──
    if (!prompt)
        die('print mode needs a prompt (an argument or stdin)');
    if (!session.title)
        session.title = (0, session_1.titleFrom)(prompt);
    // stdout carries only the answer; with --verbose the activity goes to stderr.
    const renderer = new render_1.TerminalRenderer(process.stderr, { showText: args.verbose, showReasoning: args.verbose, spinner: false });
    const events = args.verbose ? renderer : {
        thinking() { }, text() { }, reasoning() { }, toolCallStreaming() { }, toolStart() { }, toolEnd() { }, status() { }, assistantEnd() { }, sources() { },
        notice: m => { process.stderr.write(`${ui_1.c.yellow('!')} ${m}\n`); },
    };
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    process.on('SIGTERM', () => controller.abort());
    const result = await agent.run(prompt, events, controller.signal);
    session.messages = agent.messages;
    session.usage = agent.usage;
    (0, session_1.saveSession)(session);
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
    }
    else {
        if (result.text)
            process.stdout.write(result.text.trimEnd() + '\n');
        if (result.error)
            process.stderr.write(`${ui_1.c.red('error:')} ${result.error}\n`);
    }
    process.exit(result.stopped ? 130 : isError ? 1 : 0);
}
main().catch(err => die((0, client_1.describeError)(err)));
//# sourceMappingURL=cli.js.map