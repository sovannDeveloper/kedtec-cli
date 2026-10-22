# KEDTec CLI Bridge

Lets the `kedtec` terminal CLI see the file open in this VS Code window and the
lines selected in it. The CLI shows them under its input box (`⧉ In ui.ts`,
`⧉ 12 lines selected`) and sends the selection with your next message.

The CLI installs this extension by itself the first time it runs in a VS Code
terminal. It has no settings and no UI: it writes the editor state to
`~/.kedtec/ide/<pid>.json`, and nothing leaves your machine.
