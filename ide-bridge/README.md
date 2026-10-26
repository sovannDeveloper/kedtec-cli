# KEDTec for VS Code

**Chat.** The KEDTec view in the activity bar runs the `kedtec` CLI's agent in
the editor. It reads, edits and runs commands in the open folder, asking first
according to the permission mode under the input. It shares the CLI's
configuration (`~/.kedtec/config.json`, set with **KEDTec: Sign In**) and its
saved conversations.

**Bridge.** It also lets the `kedtec` terminal CLI see the file open in this
window and the lines selected in it. The CLI shows them under its input box
(`⧉ In ui.ts`, `⧉ 12 lines selected`) and sends the selection with your next
message. For this it writes the editor state to `~/.kedtec/ide/<pid>.json`.

The CLI installs this extension by itself the first time it runs in a VS Code
terminal. The chat sends your messages only to the endpoint you configured.
