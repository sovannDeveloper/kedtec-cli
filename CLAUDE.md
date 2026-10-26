# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`kedtec` is a Claude Code–style terminal coding agent (TypeScript, Node ≥18.17). It talks OpenAI Chat Completions (the `openai` SDK is the only runtime dependency) to the KEDTec AI API or any OpenAI-compatible endpoint. `ide-bridge/` is the VS Code extension: it reports the open file and selection to the CLI, and its chat panel (`chat.ts` + `media/chat.js`) runs the same `Agent` from `src/` in the editor. README.md is the user-facing spec for behavior (permission modes, slash commands, env vars, print mode). Read it before you change anything users can see.

## Commands

```bash
npm run compile    # tsc type check (noEmit) + esbuild → dist/ (minified CJS, one file per src file)
npm run watch      # esbuild on change, no type check
npm run typecheck  # tsc only
npm test           # compile, then node --test test/*.test.js
node dist/cli.js   # run the CLI without linking
npm run bridge     # rebuild dist/kedtec-ide-bridge-<version>.vsix from ide-bridge/
```

To run the extension, press F5 in VS Code ("Run KEDTec extension" in `.vscode/launch.json`). It runs `node ide-bridge/build.js --dev` (unminified, with a source map) and opens an Extension Development Host on this repo. Changes to `media/` show after "Developer: Reload Webviews". Changes to `.ts` files need the host restarted.

Run a single test (after `npm run compile`, because the tests `require('../dist/...')`, not `src/`):

```bash
node --test --test-name-pattern="glob" test/core.test.js
```

## Rules that are easy to break

- **`dist/` is committed and is what users install** (`npm i -g github:sovannDeveloper/kedtec-cli`, with no build step). After every `src/` change, run `npm run compile` (or `npm test`) so `dist/` matches `src/`.
- **Never add a `build` npm script.** npm runs a full dependency install inside the git checkout of any package that has one, and on a global install this breaks the install folder. That is why the script is named `compile`.
- Stack traces from `dist/` point into minified code with no source maps. Debug by reading the matching file in `src/`.
- The version lives only in `package.json`, and `kedtec --version` reads it at run time. Release flow: `npm test` → commit → `npm version patch` → `git push --follow-tags`.
- When `ide-bridge/` changes, bump `ide-bridge/package.json` version and run `npm run bridge`. The CLI auto-updates the extension where it is missing or older. The extension bundles `src/` (`ide-bridge/build.js`, esbuild, with `openai` inlined), so a change to the agent, tools, permissions or prompt needs a bridge rebuild too.
- `npm test` checks that the bundled `.vsix` version matches `ide-bridge/package.json`. After a bridge version bump, run `npm run bridge` before `npm test`.
- `src/shellSafety.ts`, `src/ignore.ts` and `src/diff.ts` are shared with the KEDTec VS Code extension. Keep them dependency-free and self-contained.
- The codebase deliberately avoids dependencies: colors, the spinner, Markdown rendering, diffs and gitignore matching are all hand-written. Don't add libraries for these.

## Architecture

Entry: `src/cli.ts` parses flags and subcommands (`login`, `config`, `models`, `-p` print mode), resolves config, checks folder trust (`trust.ts`), builds the system prompt, then either runs one task (print mode) or hands off to `repl.ts`.

The core loop is `agent.ts` (`Agent`). It holds `messages`, calls `client.ts` (`streamTurn`) for each turn, dispatches tool calls through `tools.ts`, and auto-compacts near the context limit (`compact()`). It never writes to the terminal. It reports everything through the `AgentEvents` interface, which `render.ts` (`TerminalRenderer`) implements for the interactive UI. Print mode renders the same events differently.

- **`client.ts`**: all HTTP to the model. Defines `ChatMessage` and `ContentPart` (images go as `image_url` parts), streaming, first-chunk timeouts, error-body rewriting, and model listing (`/v1/models` merged with the user's `customModels`).
- **`tools.ts`**: the tool set exposed to the model. `TOOLS` = `read_file`, `write_file`, `edit_file`, `list_dir`, `glob_files`, `grep_files`, `run_command`, `todo_write`, `ask_user`. Each tool calls `ctx.permissions.check({kind: 'edit'|'command'|'outside', ...})` before acting. Edits require a prior read and are refused if the file changed on disk since that read.
- **Permission pipeline**: `permissions.ts` (`Permissions` class: mode + remembered command prefixes + an `Asker` callback) → `shellSafety.ts` (`classifyCommand` decides whether a command is a safe read that runs without asking, `assessRisk` lists the fixed rules that force a prompt even in auto mode, `commandReach` checks paths outside the project) → `shell.ts` (bash on Unix, and Git Bash or else `cmd.exe` on Windows; under `cmd.exe` no command counts as a safe read).
- **`memory.ts`**: per-project memory in `~/.kedtec/memory/<projectKey>/` (the key comes from the git root and matches `session.ts`). It holds one front-matter Markdown file per memory plus a regenerated `MEMORY.md` index. `memoryPrompt()` puts the `project-structure` memory in full and an index of the others into the system prompt. When `project-structure` is missing in an interactive session, it tells the agent to map the project before the first request. The `memory` tool (save, read, list, delete) needs no approval. Memory is off with `--no-project-config`, where `memoryDir` is undefined and the tool is not offered.
- **`prompt.ts`**: builds the system prompt. It loads `KEDTEC.md` / `CLAUDE.md` / `AGENTS.md` from the git root down to cwd plus `~/.kedtec/KEDTEC.md` (40 KB per file, 80 KB total), and skips project files with `--no-project-config`.
- **Interactive UI**: `repl.ts` holds the slash commands and the session loop. `screen.ts` is the full-screen transcript, input box and status line, and mouse/scroll handling. `input.ts` covers raw key input, history, `select` / `questionForm` / `tabbedPanel` prompts, and the `ask_user` forms. `ui.ts` holds the ANSI primitives, `Spinner` and `MarkdownStream`.
- **Attachments**: `images.ts` (clipboard and file images, 5 MB limit, `sips` downscale on macOS), `pastes.ts` (long pastes saved to temp files and shown as `[Pasted text #N]`) and `mentions.ts` (`@file` mentions: `expandMentions` attaches them, `makeMentionFinder` suggests paths). The CLI and the VS Code chat panel share `mentions.ts`; `repl.ts` re-exports `expandMentions` / `parseMention` for older callers.
- **VS Code chat** (`ide-bridge/src/chat.ts`): a `WebviewViewProvider` that builds the same `Agent` / `Permissions` as `cli.ts` and implements `AgentEvents`, the permission `Asker` and `ask_user` by posting to the webview (`ide-bridge/media/chat.js`, plain JS with a hand-written Markdown renderer). The webview only draws. It passes `host: 'vscode'` to `buildSystemPrompt`, and VS Code's Restricted Mode plays the role of `--no-project-config`.
- **IDE context**: `ide.ts` reads `~/.kedtec/ide/<pid>.json`, which the bridge extension writes, and picks the window whose workspace contains cwd. `ideBridge.ts` installs or updates the bundled `.vsix`.
- **State on disk**: `config.ts` (`~/.kedtec` or `$KEDTEC_HOME`: `config.json` with mode 600, `sessions/`). Precedence is flag › env › config file › default. `session.ts` saves and resumes conversations per directory.

Tests (`node:test`):
- `test/core.test.js` covers the pure pieces: glob matching, command prefixes, permissions, shell classification, error rewriting and config normalization. Add new cases there against `dist/` exports.
- `test/chat.test.js` drives the VS Code chat panel without VS Code. It bundles `ide-bridge/src/chat.ts` with `vscode` aliased to `test/vscode-stub.js`, uses a recording webview and a local fake OpenAI streaming server, and sets `KEDTEC_HOME` to a temp dir. It awaits `panel.receive(msg)` (the webview message handler) so each turn completes. Add panel behavior tests there.
