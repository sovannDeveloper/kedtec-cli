"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Agent = void 0;
const client_1 = require("./client");
const tools_1 = require("./tools");
// How many times a reply cut off by max_tokens is asked to carry on before the
// loop gives up on it.
const MAX_CONTINUATIONS = 2;
// Compact automatically once a request uses this share of a known window.
const AUTO_COMPACT_FRACTION = 0.8;
class Agent {
    opts;
    messages = [];
    usage = { prompt: 0, completion: 0 };
    lastPromptTokens = 0;
    readState = new Map();
    todos = [];
    constructor(opts) {
        this.opts = opts;
    }
    schemas() {
        return (0, tools_1.toolSchemas)(tools_1.TOOLS);
    }
    async run(input, events, signal) {
        if (this.shouldCompact()) {
            events.notice('Context is nearly full — compacting the conversation first.');
            try {
                await this.compact(signal);
            }
            catch (err) {
                events.notice(`Compaction failed: ${(0, client_1.describeError)(err)}`);
            }
        }
        this.messages.push({ role: 'user', content: input });
        let lastText = '';
        let continuations = 0;
        for (let turn = 1; turn <= this.opts.maxTurns; turn++) {
            events.thinking();
            let partial = '';
            let result;
            try {
                result = await (0, client_1.streamTurn)(this.opts.client, {
                    model: this.opts.model,
                    messages: [{ role: 'system', content: this.opts.systemPrompt() }, ...this.messages],
                    tools: this.schemas(),
                    maxTokens: this.opts.maxTokens,
                    temperature: this.opts.temperature,
                }, {
                    onText: d => { partial += d; events.text(d); },
                    onReasoning: d => events.reasoning(d),
                    onToolCall: name => events.toolCallStreaming((0, tools_1.findTool)(name)?.label ?? name),
                }, signal);
            }
            catch (err) {
                events.assistantEnd();
                // Whatever was already said stays in the history, so the next message
                // is understood in the context the user actually saw.
                if (partial.trim())
                    this.messages.push({ role: 'assistant', content: `${partial}\n\n[interrupted]` });
                const stopped = err instanceof client_1.StoppedError || signal.aborted;
                return { text: partial || lastText, turns: turn, stopped, error: stopped ? undefined : (0, client_1.describeError)(err) };
            }
            events.assistantEnd();
            this.usage.prompt += result.usage.prompt;
            this.usage.completion += result.usage.completion;
            if (result.usage.prompt)
                this.lastPromptTokens = result.usage.prompt;
            if (result.sources.length || result.research.length)
                events.sources(result.sources, result.research);
            const assistant = {
                role: 'assistant',
                content: result.text || (result.toolCalls.length > 0 ? null : ''),
            };
            if (result.toolCalls.length > 0) {
                assistant.tool_calls = result.toolCalls.map(call => ({
                    id: call.id, type: 'function', function: { name: call.name, arguments: call.args || '{}' },
                }));
                // A thinking backend wants its reasoning back beside the calls it made.
                if (result.reasoning)
                    assistant.reasoning_content = result.reasoning;
            }
            this.messages.push(assistant);
            if (result.text.trim())
                lastText = result.text;
            if (result.toolCalls.length === 0) {
                if (result.finishReason === 'length' && continuations < MAX_CONTINUATIONS) {
                    continuations++;
                    this.messages.push({ role: 'user', content: 'Your reply was cut off by the output limit. Continue exactly where you stopped.' });
                    continue;
                }
                return { text: lastText, turns: turn, stopped: false };
            }
            for (const call of result.toolCalls) {
                if (signal.aborted) {
                    this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Not run: interrupted by the user.' });
                    continue;
                }
                const outcome = await this.runTool(call, result.finishReason, events, signal);
                this.messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.isError ? `Error: ${outcome.content}` : outcome.content });
            }
            if (signal.aborted)
                return { text: lastText, turns: turn, stopped: true };
        }
        return { text: lastText, turns: this.opts.maxTurns, stopped: false, error: `Stopped after ${this.opts.maxTurns} turns (--max-turns).` };
    }
    async runTool(call, finishReason, events, signal) {
        const tool = (0, tools_1.findTool)(call.name);
        if (!tool) {
            const outcome = { content: `Unknown tool "${call.name}". Available: ${tools_1.TOOLS.map(t => t.name).join(', ')}.`, isError: true };
            events.toolStart(call.name, '');
            events.toolEnd(outcome);
            return outcome;
        }
        let input;
        try {
            const parsed = JSON.parse(call.args || '{}');
            input = parsed && typeof parsed === 'object' ? parsed : {};
        }
        catch (err) {
            const truncated = finishReason === 'length';
            const outcome = {
                isError: true,
                content: truncated
                    ? 'The arguments were cut off by the output limit, so nothing ran. Split the work into smaller calls (several edit_file calls, or a shorter write_file) and try again.'
                    : `The arguments were not valid JSON (${err.message}), so nothing ran. Check quoting and escaping of large strings and try again.`,
            };
            events.toolStart(tool.label, '');
            events.toolEnd(outcome);
            return outcome;
        }
        events.toolStart(tool.label, tool.summary(input, this.opts.root));
        let outcome;
        try {
            outcome = await tool.run(input, {
                root: this.opts.root,
                permissions: this.opts.permissions,
                readState: this.readState,
                todos: this.todos,
                signal,
                status: label => events.status(label),
            });
        }
        catch (err) {
            outcome = { content: `The tool failed: ${(0, client_1.describeError)(err)}`, isError: true };
        }
        events.toolEnd(outcome);
        return outcome;
    }
    shouldCompact() {
        const cw = this.opts.contextWindow;
        return !!cw && this.lastPromptTokens > cw * AUTO_COMPACT_FRACTION && this.messages.length > 4;
    }
    // Replace the conversation with a summary of it. The file read-state is
    // cleared with it: after compaction the model no longer holds those files'
    // contents, so it must read them again before editing.
    async compact(signal, focus) {
        if (this.messages.length === 0)
            return '';
        const transcript = this.messages.map(m => {
            if (m.role === 'tool')
                return `[tool result]\n${clipText(m.content, 1500)}`;
            if (m.role === 'assistant') {
                const calls = (m.tool_calls ?? []).map(t => `[called ${t.function.name} ${clipText(t.function.arguments, 300)}]`).join('\n');
                return `[assistant]\n${m.content ?? ''}${calls ? `\n${calls}` : ''}`;
            }
            return `[${m.role}]\n${clipText(m.content, 6000)}`;
        }).join('\n\n');
        const summary = await (0, client_1.completeOnce)(this.opts.client, this.opts.model, [
            {
                role: 'system',
                content: 'You summarise a coding session so it can continue with no other context. Be specific and complete: '
                    + 'the user\'s goals and requirements, decisions made, files read and changed (with paths and what changed), '
                    + 'commands run and their results, errors still open, and the exact next steps. Use concise Markdown bullets.',
            },
            { role: 'user', content: `${focus ? `Pay particular attention to: ${focus}\n\n` : ''}Session transcript:\n\n${clipText(transcript, 120_000)}` },
        ], 4096, signal);
        if (!summary.trim())
            throw new Error('the model returned an empty summary');
        this.messages = [
            { role: 'user', content: `This conversation was compacted. Summary of everything so far:\n\n${summary.trim()}` },
            { role: 'assistant', content: 'Understood — continuing from that summary. I will re-read any file before editing it.' },
        ];
        this.readState.clear();
        this.lastPromptTokens = 0;
        return summary.trim();
    }
    clear() {
        this.messages = [];
        this.readState.clear();
        this.todos.splice(0);
        this.lastPromptTokens = 0;
    }
}
exports.Agent = Agent;
function clipText(s, n) {
    return s.length > n ? `${s.slice(0, n)}… [${s.length - n} chars omitted]` : s;
}
//# sourceMappingURL=agent.js.map