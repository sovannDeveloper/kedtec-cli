// The part of the `vscode` API the chat panel (ide-bridge/src/chat.ts) uses,
// for test/chat.test.js. The bundle under test is built with `vscode` aliased
// to this file; each test sets globalThis.vscodeStubRoot to its project folder
// and reads what the panel did from globalThis.vscodeStubCalls.
const path = require('path');

const calls = globalThis.vscodeStubCalls = globalThis.vscodeStubCalls || [];

module.exports = {
  workspace: {
    get workspaceFolders() { return [{ uri: { fsPath: globalThis.vscodeStubRoot, scheme: 'file' } }]; },
    isTrusted: true,
    getWorkspaceFolder: () => undefined,
    openTextDocument: async p => ({ path: p }),
  },
  window: {
    activeTextEditor: undefined,
    showWarningMessage: message => { calls.push({ warning: message }); },
    showInformationMessage: message => { calls.push({ info: message }); },
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => {},
  },
  commands: { executeCommand: async () => {} },
  Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }) },
  ViewColumn: { One: 1 },
  Range: class {},
};
