# kedtec — KEDTec in the terminal

A Claude Code–style coding agent for the terminal. It talks to the KEDTec AI API
(or any OpenAI-compatible endpoint) and works directly in your project: it reads
and searches files, edits them with a diff you approve, runs builds and tests,
and keeps a checklist for multi-step work. The same binary runs non-interactively
in CI.

## Install

```bash
npm i -g github:sovannDeveloper/kedtec-cli   # puts `kedtec` on your PATH
kedtec login      # endpoint, API token (from /admin/tokens), default model
```

Requires Node 18.17+ and git.

The built `dist/` is committed, so installing from GitHub needs no build step.
Run `npm run compile` before each push so it matches `src/`. (The script is not
called `build` on purpose: npm runs a full dependency install inside the git
checkout of any package with a `build` script, and on a global install that
inner install writes into the real install folder and breaks it.)

To update, run the same install command again; it fetches the latest `main`.
Your login and settings in `~/.kedtec` are kept. Check with `kedtec --version`.
If the old version stays, npm reused a cached copy: `npm uninstall -g kedtec`
first. To pin a release, install a tag instead:
`npm i -g github:sovannDeveloper/kedtec-cli#v0.1.2`.

### Windows

Works in Windows Terminal, PowerShell and cmd. Install
[Git for Windows](https://git-scm.com/download/win) as well: commands then run in
its Git Bash, which is what the agent writes and what the safety checks
understand. It is found next to the `git` on your PATH or in the standard
install folders; set `KEDTEC_GIT_BASH` to the full path of `bash.exe` if yours
lives elsewhere. The WSL `bash.exe` is never used.

Without Git Bash, commands run in `cmd.exe`. That works, but `cmd.exe` expands
`%VAR%` anywhere in a command, so no command can be shown to be a safe read:
every one asks first (auto mode included), and Plan mode runs none — the agent
reads and searches with its file tools instead.

## Interactive use

```bash
cd your-project
kedtec                          # start a session
kedtec "why does the login test fail?"
kedtec --continue               # pick up the last conversation in this directory
```

The first session in a folder asks whether you trust it ("Accessing workspace"),
since the agent reads, edits and runs commands there and a project's
`.kedtec/settings.json` can pre-approve commands. **No, exit** is the default.
The answer is kept in `~/.kedtec/trusted.json` and covers every subfolder;
your home directory and `/` are only ever trusted for the current session.
Print mode (`-p`, CI) never asks.

| Input | Effect |
| --- | --- |
| `/help` | list commands |
| `/model [id]` · `/models` | switch or list models (the picker reads the endpoint's `/v1/models`) |
| `/mode [default\|acceptEdits\|auto\|plan\|bypass]` · `/plan` | permission mode (no argument cycles) |
| `/compact [focus]` | summarise the conversation to free context (also automatic near the limit) |
| `/clear` · `/resume` | new conversation · reopen an earlier one |
| `/init` | have the agent write a `KEDTEC.md` for the project |
| `/todos` · `/cost` · `/status` | checklist · token usage · configuration |
| `!npm test` | run a command yourself; the output joins the conversation |
| `@src/app.ts` | attach a file to your message |
| `@src/app.ts#L10-20` · `@src/app.ts:10-20` · `@src/app.ts #10-20` | attach just those lines (works with any editor, or none) |

Attachments share a budget of 60,000 characters per message, since the API
refuses a message over 100,000. A file over it is not attached: the CLI says so,
and the model can still read it with its tools.
| `\` at line end | continue on the next line (pasting several lines also works) |
| `esc` / `ctrl+c` | interrupt the agent; `ctrl+c` twice at the prompt quits |

The session runs full-screen: the input box and the status line (permission
mode, model, context use) stay fixed at the bottom, and only the conversation
above them scrolls — mouse wheel, PgUp/PgDn, or shift+↑/↓ for a line. While you
are scrolled back, new output does not move the view and the rule above the box
says how many lines are below; sending a message, or an approval prompt, returns
to the bottom. On exit the whole conversation is printed into the terminal's
normal history.

Scrolling with the wheel means the terminal reports the mouse to kedtec, which
takes plain drag-to-select away: hold Shift to select (on a Mac in VS Code, turn
on `terminal.integrated.macOptionClickForcesSelection` and hold Option), or run
`/mouse off` to give dragging back and scroll with PgUp/PgDn. `KEDTEC_MOUSE=0`
starts with the mouse off.
While the agent works, a line above the box shows what it is doing, the elapsed
time and tokens received; a finished turn ends with a line such as `✻ Baked for 8s`.
shift+tab cycles the permission mode (default → accept edits → auto → plan).
In the box: Enter sends, ctrl+j or alt+enter adds a line (pastes keep their
newlines), ↑/↓ walk history, Tab completes slash commands, Esc clears.
`KEDTEC_STATUSBAR=0` falls back to a plain prompt that follows the output.

## VS Code integration

Run `kedtec` in a VS Code terminal and the status line shows the file open in
that window (`⧉ In ui.ts`), or how many lines are selected (`⧉ 12 lines
selected`). The next message carries that selection to the model, or a note
naming the open file; it is sent once per change, not on every message.

This needs the small KEDTec CLI Bridge extension (`ide-bridge/`), which the CLI
installs into the editor itself the first time it runs in a VS Code terminal
(Cursor and other VS Code forks too). If the file does not show right away, run
**Developer: Reload Window**. Set `KEDTEC_NO_IDE_BRIDGE=1` to stop the CLI from
installing it. The extension writes the editor state to `~/.kedtec/ide/<pid>.json`
and the CLI picks the window whose workspace contains the current directory.

That also works from Terminal.app, iTerm or any other terminal, once the
extension is installed and VS Code has the project open. Other editors
(Android Studio, Xcode) have no bridge: name the lines yourself with
`@path/to/file#L10-20`.

## Permission modes

| Mode | File edits | Shell commands |
| --- | --- | --- |
| `default` | ask, with a diff | ask (plain reads such as `ls`, `grep`, `cat` inside the project run freely — not with options that write or run something, such as `sed -e`, `sort -o` or `rg --pre`) |
| `acceptEdits` | apply automatically inside the project | ask |
| `auto` | apply automatically inside the project | run automatically, except risky ones (below), which ask |
| `plan` | blocked: the agent investigates and proposes a plan | read-only commands only |
| `bypass` | automatic | automatic (`--dangerously-skip-permissions`) |

Auto mode still asks before a command that deletes recursively (`rm -r`,
`find -delete`), discards git work (`reset --hard`, `clean`, `checkout .`,
`branch -D`, rebases and amends), publishes (`git push`, `npm publish`, `gh`
writes), sends data (`curl -d`), pipes anything into a shell, acts on the
machine or another one (`sudo`, `kill`, `brew`, global installs, `ssh`,
`docker rm`, `kubectl apply`), uses `$(…)` substitution, or names a path
outside the project — and says which rule it hit. The rules are fixed
(`assessRisk` in `src/shellSafety.ts`), so the same command always gets the
same answer. In print mode a flagged command is refused rather than asked.

The mode you pick with shift+tab or `/mode` is remembered as the default for
the next session (saved as `permissionMode` in the config). Bypass is never
remembered; it has to be asked for each time with `--dangerously-skip-permissions`.

Answering "Yes, and don't ask again" remembers a command prefix such as
`npm test` for the session. Prefixes only match a single plain command, so
`npm test && rm -rf ~` never matches `npm test`. Persistent allowances go in
`allowedCommands` (`kedtec config set allowedCommands "npm test, git status"`)
or in a project's `.kedtec/settings.json`:

```json
{ "allowedCommands": ["npm test", "npm run lint"] }
```

Files must be read before they can be edited, and an edit is refused if the
file changed on disk since it was read.

## Project instructions

The agent reads `KEDTEC.md`, `CLAUDE.md` and `AGENTS.md` from the git root
down to the current directory, plus `~/.kedtec/KEDTEC.md`, into its system
prompt. Very large files are truncated (40 KB each, 80 KB total), and the model
is told it can read the rest.

## CI / scripting (print mode)

`-p` runs one task and prints only the final answer on stdout. Piped stdin is
appended to the prompt. With no terminal, nobody can approve anything, so
choose the mode up front:

```bash
kedtec -p "fix the lint errors" --permission-mode acceptEdits
git diff origin/main...HEAD | kedtec -p "review this diff for bugs" --permission-mode plan
kedtec -p "summarise the failing tests" --output-format json --max-turns 30
```

Configuration comes from the environment, so CI needs no config file:

| Variable | Meaning |
| --- | --- |
| `KEDTEC_API_KEY` | API token (`OPENAI_API_KEY` is also read) |
| `KEDTEC_ENDPOINT` | base URL, e.g. `http://host:3000/v1` |
| `KEDTEC_MODEL` | model id (default: the endpoint's first, i.e. the registry default) |
| `KEDTEC_PERMISSION_MODE` | `default` · `acceptEdits` · `auto` · `plan` · `bypass` |
| `KEDTEC_MAX_TOKENS` | cap on each reply |
| `KEDTEC_HOME` | where config, sessions and history live (default `~/.kedtec`) |

Exit codes: `0` success, `1` error (including `--max-turns` reached), `130` interrupted.
`--output-format json` prints one object:
`{"type":"result","is_error":false,"result":"…","turns":4,"model":"…","session_id":"…","usage":{…}}`.

See [examples/github-actions.yml](examples/github-actions.yml) for a pull-request review job.

When the checkout is not yours to trust — a pull request's code — pass
`--no-project-config`: the project's `KEDTEC.md`, `CLAUDE.md`, `AGENTS.md` and
`.kedtec/settings.json` are then ignored rather than followed (`~/.kedtec/KEDTEC.md`
still applies). Commands the agent runs never see the API key: `KEDTEC_API_KEY` is
removed from their environment, and so is `OPENAI_API_KEY` when that is where the
key came from.

## Configuration

```bash
kedtec config                          # show what is in effect (key masked)
kedtec config set model backend
kedtec config set permissionMode acceptEdits
kedtec config unset model
kedtec logout                          # forget the API key
```

Precedence: command-line flag › environment › `~/.kedtec/config.json` › default.
The config file is written with mode `600`.

## Development

```bash
npm run watch     # rebuild dist/ on change (no type check)
npm run typecheck # tsc, no output
npm test          # type check + build + unit tests (node:test)
node dist/cli.js  # run without linking
```

`npm run compile` type-checks with `tsc` and then has esbuild write `dist/`:
one minified CommonJS file per source file, without source maps. Errors and
stack traces from `dist/` therefore point into minified code; to debug, read
the matching file in `src/`.

### Releasing

The version lives only in `package.json`; `kedtec --version` reads it at run
time, so there is no constant in `src/` to keep in step.

```bash
npm test                          # compiles too: dist/ must match src/ — it is what users install
git add -A && git commit -m "…"   # npm version needs a clean working tree
npm version patch                 # or minor / major: bumps, commits and tags vX.Y.Z
git push --follow-tags
```

Users then update with `npm i -g github:sovannDeveloper/kedtec-cli` (see Install).

After changing `ide-bridge/`, bump its version in `ide-bridge/package.json` and
run `npm run bridge`: it rebuilds `dist/kedtec-ide-bridge-<version>.vsix`, and
the CLI updates the extension in any window where it is missing or older.

`src/shellSafety.ts`, `src/ignore.ts` and `src/diff.ts` are shared with the
KEDTec VS Code extension: the read-only command classifier, the `.gitignore`
matcher and the diff renderer.
