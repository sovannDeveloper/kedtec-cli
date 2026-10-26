// The VS Code chat panel (ide-bridge/src/chat.ts) driven without VS Code: the
// panel is bundled with `vscode` replaced by test/vscode-stub.js, its webview
// is a recorder, and the model is a local server speaking the OpenAI streaming
// protocol. What is checked is what the panel does with the agent: the
// messages it posts, the approvals it asks for, the files and sessions it writes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kedtec-chat-'));
// Read when config.ts loads, so it is set before the bundle is.
process.env.KEDTEC_HOME = path.join(tmp, 'home');
process.env.KEDTEC_API_KEY = 'test-key';
delete process.env.KEDTEC_MODEL;
delete process.env.KEDTEC_PERMISSION_MODE;

let ChatViewProvider;
let historyItems;
let server;
// What the fake model answers to the n-th streamed request of a test.
let replies = [];
let requests = [];

before(async () => {
  const bundle = path.join(tmp, 'chat.js');
  require('esbuild').buildSync({
    entryPoints: [path.join(__dirname, '..', 'ide-bridge', 'src', 'chat.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    alias: { vscode: path.join(__dirname, 'vscode-stub.js') },
    logLevel: 'warning',
  });
  ({ ChatViewProvider, historyItems } = require(bundle));

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'fake-model', context_window: 32000 }] })); return; }
      const json = JSON.parse(body);
      // completeOnce: the conversation title.
      if (!json.stream) { res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Fake title' } }] })); return; }
      requests.push(json);
      const reply = replies.shift() ?? { text: 'ok' };
      res.setHeader('content-type', 'text/event-stream');
      const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (reply.text) send({ choices: [{ delta: { content: reply.text } }] });
      if (reply.tool) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } }] });
      }
      send({ choices: [{ delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 10 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.KEDTEC_ENDPOINT = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A panel on a fresh project folder, with a webview that records every
// message and answers approvals with `onPermission`.
async function openPanel(name, { onPermission = () => 'yes', selection } = {}) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  globalThis.vscodeStubRoot = root;
  // A mode picked in an earlier test (/mode is remembered) must not carry over.
  fs.rmSync(path.join(process.env.KEDTEC_HOME, 'config.json'), { force: true });
  replies = [];
  requests = [];
  const posted = [];
  let panel;
  const view = {
    show() {},
    onDidDispose() {},
    webview: {
      cspSource: 'test', options: {}, html: '',
      asWebviewUri: uri => uri,
      onDidReceiveMessage: () => {},
      postMessage: async msg => {
        posted.push(msg);
        if (msg.type === 'permission') {
          const choice = onPermission(msg);
          setImmediate(() => panel.receive(choice === 'stop' ? { type: 'stop' } : { type: 'permissionAnswer', id: msg.id, choice }));
        }
      },
    },
  };
  const editor = () => ({
    pid: process.pid, workspaceFolders: [root], file: path.join(root, 'a.ts'), selection: null,
    selections: selection ? [selection] : [], updated: Date.now(),
  });
  panel = new ChatViewProvider({ extensionUri: { fsPath: path.join(__dirname, '..', 'ide-bridge') } }, editor);
  panel.resolveWebviewView(view);
  // receive() is what the webview's messages go to; awaiting it waits for
  // the panel to finish with one, a whole turn included.
  const send = async (text, opts = {}) => {
    const from = posted.length;
    await panel.receive({ type: 'send', text, images: [], includeEditor: opts.includeEditor ?? true });
    return posted.slice(from);
  };
  await panel.receive({ type: 'ready' });
  const state = posted.find(m => m.type === 'state' || m.type === 'fatal');
  assert.strictEqual(state?.type, 'state', state?.message);
  return { root, posted, send, state };
}

test('chat panel: starts on the endpoint\'s model and offers the modes and slash commands', async () => {
  const { state } = await openPanel('start');
  assert.strictEqual(state.model, 'fake-model');
  assert.strictEqual(state.mode, 'default');
  assert.deepStrictEqual(state.modes, ['default', 'acceptEdits', 'auto', 'plan']);
  assert.ok(state.commands.some(c => c.name === '/compact' && c.args));
});

test('chat panel: an approved edit is written, and the turn is saved as a session the CLI can resume', async () => {
  const p = await openPanel('approve', { selection: { startLine: 1, endLine: 2, text: 'let x = 1;\nlet y = 2;' } });
  replies = [{ text: 'Creating it.', tool: 'write_file', args: { path: 'hello.txt', content: 'hi\n' } }, { text: 'Created `hello.txt`.' }];
  const out = await p.send('make a hello file');

  // What went to the model: the VS Code prompt and the editor selection.
  assert.match(requests[0].messages[0].content, /chat panel of the user's VS Code/);
  assert.match(requests[0].messages.at(-1).content, /^make a hello file\n\n<ide_selection file="a.ts" lines="1-2">/);
  assert.strictEqual(out.find(m => m.type === 'user').note, '⧉ Selected 2 lines from a.ts');

  const ask = out.find(m => m.type === 'permission');
  assert.strictEqual(ask.title, 'Create hello.txt');
  assert.match(ask.detail, /^\+hi$/m);
  assert.strictEqual(ask.always, 'Yes, allow all edits this session');
  assert.strictEqual(fs.readFileSync(path.join(p.root, 'hello.txt'), 'utf8'), 'hi\n');
  assert.deepStrictEqual(out.find(m => m.type === 'toolEnd'), { type: 'toolEnd', isError: false, display: 'Created hello.txt (2 lines)' });
  assert.strictEqual(out.filter(m => m.type === 'text').map(m => m.delta).join(''), 'Creating it.Created `hello.txt`.');
  assert.deepStrictEqual(out.find(m => m.type === 'done'), { type: 'done', stopped: false });

  const { listSessions } = require('../dist/session');
  const [saved] = listSessions(p.root);
  assert.strictEqual(saved.messages.length, 4);
  assert.deepStrictEqual(historyItems(saved, p.root), [
    { type: 'user', text: 'make a hello file', images: 0 },
    { type: 'assistant', text: 'Creating it.' },
    { type: 'tool', label: 'Write', summary: 'hello.txt', isError: false },
    { type: 'assistant', text: 'Created `hello.txt`.' },
  ]);
});

test('chat panel: a declined edit is not written, and the model is told why', async () => {
  const p = await openPanel('decline', { onPermission: () => 'no' });
  replies = [{ tool: 'write_file', args: { path: 'nope.txt', content: 'x' } }, { text: 'Understood.' }];
  const out = await p.send('make a file');
  assert.ok(!fs.existsSync(path.join(p.root, 'nope.txt')));
  assert.strictEqual(out.find(m => m.type === 'toolEnd').isError, true);
  assert.match(requests[1].messages.at(-1).content, /^Error: The user declined this action/);
});

test('chat panel: Stop while an approval is open declines it and ends the turn', async () => {
  const p = await openPanel('stop', { onPermission: () => 'stop' });
  replies = [{ tool: 'write_file', args: { path: 'never.txt', content: 'x' } }];
  const out = await p.send('make a file');
  assert.ok(!fs.existsSync(path.join(p.root, 'never.txt')));
  assert.deepStrictEqual(out.find(m => m.type === 'done'), { type: 'done', stopped: true });
  assert.ok(out.some(m => m.type === 'busy' && m.busy === false));
  assert.strictEqual(requests.length, 1);
});

test('chat panel: slash commands run in the panel; a message starting with a path is still sent', async () => {
  const p = await openPanel('slash');
  const help = (await p.send('/help')).find(m => m.type === 'info');
  assert.match(help.text, /^\/help — /);
  assert.match(help.text, /^\/compact \[focus\] — /m);

  const mode = await p.send('/mode auto');
  assert.strictEqual(mode.find(m => m.type === 'state').mode, 'auto');
  assert.strictEqual((await p.send('/plan')).find(m => m.type === 'state').mode, 'plan');
  assert.match((await p.send('/mode nonsense')).find(m => m.type === 'notice').message, /^Unknown mode "nonsense"/);
  assert.match((await p.send('/status')).find(m => m.type === 'info').text, /^endpoint +http:\/\/127\.0\.0\.1:\d+\/v1$/m);
  assert.strictEqual((await p.send('/todos')).find(m => m.type === 'info').text, 'No todos.');
  assert.match((await p.send('/nope')).find(m => m.type === 'notice').message, /^Unknown command \/nope/);
  assert.strictEqual(requests.length, 0, 'no command reached the model');

  replies = [{ text: 'Looking.' }];
  await p.send('/src/x.ts is broken', { includeEditor: false });
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].messages.at(-1).content, '/src/x.ts is broken');
});

test('chat panel: /init sends the CLI\'s prompt but shows "/init"', async () => {
  const p = await openPanel('init');
  const { INIT_PROMPT } = require('../dist/prompt');
  const out = await p.send('/init', { includeEditor: false });
  assert.strictEqual(out.find(m => m.type === 'user').text, '/init');
  assert.strictEqual(requests[0].messages.at(-1).content, INIT_PROMPT);
});
