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
exports.StoppedError = void 0;
exports.rewriteErrorBody = rewriteErrorBody;
exports.createClient = createClient;
exports.describeError = describeError;
exports.streamTurn = streamTurn;
exports.completeOnce = completeOnce;
exports.listModels = listModels;
const openai_1 = __importStar(require("openai"));
const REQUEST_TIMEOUT_MS = 120_000;
// A stream that opened and then went silent would otherwise hold the turn open
// forever. Two budgets, because "nothing yet" and "nothing since" are different
// failures: many gateways buffer a large tool call's arguments and flush them in
// one frame, so a long gap after the first chunk is normal.
const FIRST_CHUNK_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 300_000;
const MAX_ERROR_BODY_CHARS = 500;
// FastAPI answers `{"detail": "…"}`, which the SDK cannot read (it looks for
// `error.message`), so the one sentence explaining a failure would be dropped.
// Rewrite such bodies into the envelope the SDK understands.
function rewriteErrorBody(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return null;
    const body = parsed;
    if ('error' in body)
        return null;
    const candidate = ['detail', 'message', 'msg'].map(k => body[k]).find(v => typeof v === 'string' && v);
    const message = candidate ?? JSON.stringify(body);
    return JSON.stringify({ error: { message: message.slice(0, MAX_ERROR_BODY_CHARS) } });
}
async function fetchWithReadableErrors(input, init) {
    const response = await fetch(input, init);
    if (response.ok)
        return response;
    const text = await response.text().catch(() => '');
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    const rewritten = text ? rewriteErrorBody(text) : null;
    return new Response(rewritten ?? text, { status: response.status, statusText: response.statusText, headers });
}
function createClient(endpoint, apiKey) {
    // A query string (Azure's ?api-version=) must survive the SDK appending the
    // route to baseURL, so it is split off into defaultQuery.
    const url = new URL(endpoint);
    const defaultQuery = Object.fromEntries(url.searchParams);
    url.search = '';
    return new openai_1.default({
        baseURL: url.toString().replace(/\/+$/, ''),
        apiKey: apiKey || 'no-key',
        defaultQuery,
        timeout: REQUEST_TIMEOUT_MS,
        maxRetries: 2,
        fetch: fetchWithReadableErrors,
    });
}
class StoppedError extends Error {
    constructor() { super('Interrupted by user.'); }
}
exports.StoppedError = StoppedError;
function describeError(err) {
    if (err instanceof StoppedError || err instanceof openai_1.APIUserAbortError)
        return 'Interrupted by user.';
    if (err instanceof openai_1.APIConnectionTimeoutError)
        return `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`;
    if (err instanceof openai_1.APIError) {
        const status = err.status ? `${err.status} ` : '';
        const hint = err.status === 401 ? ' — check the API key (kedtec login, or KEDTEC_API_KEY).'
            : err.status === 404 ? ' — check the model id (/models) and the endpoint.'
                : err.status === 429 ? ' — rate limited or over quota.'
                    : '';
        return `${status}${err.message.replace(/^\d{3}\s+/, '')}${hint}`;
    }
    if (err instanceof Error) {
        const cause = err.cause;
        if (cause?.code === 'ECONNREFUSED')
            return `Cannot reach the API (${cause.message}). Is the endpoint right?`;
        return err.message;
    }
    return String(err);
}
async function streamTurn(client, req, handlers, signal) {
    const local = new AbortController();
    let watchdogFired = false;
    const onAbort = () => local.abort();
    if (signal.aborted)
        throw new StoppedError();
    signal.addEventListener('abort', onAbort, { once: true });
    let timer;
    const arm = (ms) => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => { watchdogFired = true; local.abort(); }, ms);
    };
    arm(FIRST_CHUNK_TIMEOUT_MS);
    const payload = {
        model: req.model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stream: true,
        stream_options: { include_usage: true },
    };
    if (req.tools.length > 0) {
        payload.tools = req.tools;
        payload.tool_choice = 'auto';
    }
    const result = {
        text: '', reasoning: '', toolCalls: [], usage: { prompt: 0, completion: 0 }, sources: [], research: [], cached: false,
    };
    const calls = new Map();
    try {
        const stream = await client.chat.completions.create(payload, { signal: local.signal });
        for await (const chunk of stream) {
            arm(IDLE_TIMEOUT_MS);
            const raw = chunk;
            // The KEDTec API's extra top-level keys: citations, pages read, cache hit.
            if (Array.isArray(raw.sources))
                result.sources = raw.sources;
            if (Array.isArray(raw.research))
                result.research = raw.research;
            if (raw.cached === true)
                result.cached = true;
            if (chunk.usage) {
                // The last usage block wins: some backends stamp a running total on every chunk.
                result.usage = { prompt: chunk.usage.prompt_tokens ?? 0, completion: chunk.usage.completion_tokens ?? 0 };
            }
            const choice = chunk.choices?.[0];
            if (!choice)
                continue;
            const delta = (choice.delta ?? {});
            const reasoning = (delta.reasoning_content ?? delta.reasoning);
            if (typeof reasoning === 'string' && reasoning) {
                result.reasoning += reasoning;
                handlers.onReasoning?.(reasoning);
            }
            if (typeof delta.content === 'string' && delta.content) {
                result.text += delta.content;
                handlers.onText?.(delta.content);
            }
            const toolDeltas = delta.tool_calls;
            for (const td of toolDeltas ?? []) {
                const index = td.index ?? 0;
                let call = calls.get(index);
                if (!call) {
                    call = { id: td.id ?? '', name: '', args: '' };
                    calls.set(index, call);
                }
                if (td.id)
                    call.id = td.id;
                if (td.function?.name) {
                    const first = !call.name;
                    call.name += td.function.name;
                    if (first)
                        handlers.onToolCall?.(call.name);
                }
                if (td.function?.arguments)
                    call.args += td.function.arguments;
            }
            if (choice.finish_reason)
                result.finishReason = choice.finish_reason;
        }
    }
    catch (err) {
        if (signal.aborted)
            throw new StoppedError();
        if (watchdogFired)
            throw new Error('The model stream went silent and was closed. Try again, or ask for a smaller change.');
        throw err;
    }
    finally {
        if (timer)
            clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
    }
    result.toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, call]) => ({ ...call, id: call.id || `call_${Date.now()}_${i}` }))
        .filter(call => call.name);
    return result;
}
// One non-streaming call with no tools — for /compact and session titles.
async function completeOnce(client, model, messages, maxTokens, signal) {
    const res = await client.chat.completions.create({ model, messages, max_tokens: maxTokens, temperature: 0.2 }, { signal });
    return res.choices?.[0]?.message?.content ?? '';
}
async function listModels(endpoint, apiKey) {
    const q = endpoint.indexOf('?');
    const url = q < 0 ? `${endpoint}/models` : `${endpoint.slice(0, q)}/models${endpoint.slice(q)}`;
    const res = await fetch(url, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const body = text ? rewriteErrorBody(text) : null;
        const message = body ? JSON.parse(body).error.message : text.slice(0, 200);
        throw new Error(`GET /models answered ${res.status}${message ? `: ${message}` : ''}`);
    }
    const body = await res.json();
    const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    const seen = new Set();
    const models = [];
    for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id.trim() : '';
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
        const cw = typeof row.context_window === 'number' && row.context_window > 0 ? row.context_window
            : typeof row.max_model_len === 'number' && row.max_model_len > 0 ? row.max_model_len : undefined;
        models.push({ id, name, contextWindow: cw });
    }
    return models;
}
//# sourceMappingURL=client.js.map