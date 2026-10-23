import OpenAI, { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';

// Everything that talks HTTP to the model backend. The wire is OpenAI Chat
// Completions, which is what the KEDTec API (and every OpenAI-compatible
// gateway) speaks; the `openai` SDK owns retries and SSE framing.

// A user message with images in it is a list of parts rather than a string.
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// A message's text, with each image as "[image]" (for /compact's transcript).
export function contentText(content: string | ContentPart[]): string {
  return typeof content === 'string' ? content : content.map(p => (p.type === 'text' ? p.text : '[image]')).join('');
}

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

// A citation the KEDTec API attaches to an answer grounded in a knowledge base.
export interface KbSource { n?: number; source?: string; section?: string; similarity?: number }
export interface ResearchPage { url?: string; title?: string }

export interface TurnResult {
  text: string;
  reasoning: string;
  toolCalls: { id: string; name: string; args: string }[];
  finishReason?: string;
  usage: { prompt: number; completion: number };
  sources: KbSource[];
  research: ResearchPage[];
  cached: boolean;
}

export interface TurnHandlers {
  onText?(delta: string): void;
  onReasoning?(delta: string): void;
  onToolCall?(name: string): void;
}

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
export function rewriteErrorBody(text: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  if ('error' in body) return null;
  const candidate = ['detail', 'message', 'msg'].map(k => body[k]).find(v => typeof v === 'string' && v);
  const message = (candidate as string | undefined) ?? JSON.stringify(body);
  return JSON.stringify({ error: { message: message.slice(0, MAX_ERROR_BODY_CHARS) } });
}

async function fetchWithReadableErrors(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const response = await fetch(input, init);
  if (response.ok) return response;
  const text = await response.text().catch(() => '');
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  const rewritten = text ? rewriteErrorBody(text) : null;
  return new Response(rewritten ?? text, { status: response.status, statusText: response.statusText, headers });
}

export function createClient(endpoint: string, apiKey: string): OpenAI {
  // A query string (Azure's ?api-version=) must survive the SDK appending the
  // route to baseURL, so it is split off into defaultQuery.
  const url = new URL(endpoint);
  const defaultQuery = Object.fromEntries(url.searchParams);
  url.search = '';
  return new OpenAI({
    baseURL: url.toString().replace(/\/+$/, ''),
    apiKey: apiKey || 'no-key',
    defaultQuery,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 2,
    fetch: fetchWithReadableErrors,
  });
}

export class StoppedError extends Error {
  constructor() { super('Interrupted by user.'); }
}

export function describeError(err: unknown): string {
  if (err instanceof StoppedError || err instanceof APIUserAbortError) return 'Interrupted by user.';
  if (err instanceof APIConnectionTimeoutError) return `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`;
  if (err instanceof APIError) {
    const status = err.status ? `${err.status} ` : '';
    const hint = err.status === 401 ? ' — check the API key (kedtec login, or KEDTEC_API_KEY).'
      : err.status === 404 ? ' — check the model id (/models) and the endpoint.'
        : err.status === 429 ? ' — rate limited or over quota.'
          : '';
    return `${status}${err.message.replace(/^\d{3}\s+/, '')}${hint}`;
  }
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED') return `Cannot reach the API (${cause.message}). Is the endpoint right?`;
    return err.message;
  }
  return String(err);
}

export interface TurnRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxTokens: number;
  temperature: number;
}

export async function streamTurn(client: OpenAI, req: TurnRequest, handlers: TurnHandlers, signal: AbortSignal): Promise<TurnResult> {
  const local = new AbortController();
  let watchdogFired = false;
  const onAbort = () => local.abort();
  if (signal.aborted) throw new StoppedError();
  signal.addEventListener('abort', onAbort, { once: true });

  let timer: NodeJS.Timeout | undefined;
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { watchdogFired = true; local.abort(); }, ms);
  };
  arm(FIRST_CHUNK_TIMEOUT_MS);

  const payload: Record<string, unknown> = {
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

  const result: TurnResult = {
    text: '', reasoning: '', toolCalls: [], usage: { prompt: 0, completion: 0 }, sources: [], research: [], cached: false,
  };
  const calls = new Map<number, { id: string; name: string; args: string }>();

  try {
    const stream = await client.chat.completions.create(
      payload as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { signal: local.signal },
    );
    for await (const chunk of stream) {
      arm(IDLE_TIMEOUT_MS);
      const raw = chunk as unknown as Record<string, unknown>;
      // The KEDTec API's extra top-level keys: citations, pages read, cache hit.
      if (Array.isArray(raw.sources)) result.sources = raw.sources as KbSource[];
      if (Array.isArray(raw.research)) result.research = raw.research as ResearchPage[];
      if (raw.cached === true) result.cached = true;
      if (chunk.usage) {
        // The last usage block wins: some backends stamp a running total on every chunk.
        result.usage = { prompt: chunk.usage.prompt_tokens ?? 0, completion: chunk.usage.completion_tokens ?? 0 };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      const reasoning = (delta.reasoning_content ?? delta.reasoning) as string | undefined;
      if (typeof reasoning === 'string' && reasoning) {
        result.reasoning += reasoning;
        handlers.onReasoning?.(reasoning);
      }
      if (typeof delta.content === 'string' && delta.content) {
        result.text += delta.content;
        handlers.onText?.(delta.content);
      }
      const toolDeltas = delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined;
      for (const td of toolDeltas ?? []) {
        const index = td.index ?? 0;
        let call = calls.get(index);
        if (!call) {
          call = { id: td.id ?? '', name: '', args: '' };
          calls.set(index, call);
        }
        if (td.id) call.id = td.id;
        if (td.function?.name) {
          const first = !call.name;
          call.name += td.function.name;
          if (first) handlers.onToolCall?.(call.name);
        }
        if (td.function?.arguments) call.args += td.function.arguments;
      }
      if (choice.finish_reason) result.finishReason = choice.finish_reason;
    }
  } catch (err) {
    if (signal.aborted) throw new StoppedError();
    if (watchdogFired) throw new Error('The model stream went silent and was closed. Try again, or ask for a smaller change.');
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }

  result.toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, call]) => ({ ...call, id: call.id || `call_${Date.now()}_${i}` }))
    .filter(call => call.name);
  return result;
}

// One non-streaming call with no tools — for /compact and session titles.
export async function completeOnce(client: OpenAI, model: string, messages: ChatMessage[], maxTokens: number, signal?: AbortSignal): Promise<string> {
  const res = await client.chat.completions.create(
    { model, messages, max_tokens: maxTokens, temperature: 0.2 } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    { signal },
  );
  return res.choices?.[0]?.message?.content ?? '';
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  // A model added by hand; with an endpoint (and key) of its own when it is
  // served somewhere other than the configured endpoint.
  custom?: boolean;
  endpoint?: string;
  apiKey?: string;
}

// The endpoint's models with the hand-added ones after them; a custom model
// replaces a listed one of the same id.
export function mergeCustomModels(listed: ModelInfo[], custom: { id: string; endpoint?: string; apiKey?: string; contextWindow?: number }[]): ModelInfo[] {
  const ids = new Set(custom.map(m => m.id));
  return [
    ...listed.filter(m => !ids.has(m.id)),
    ...custom.map(m => ({
      id: m.id, name: m.id, custom: true, endpoint: m.endpoint, apiKey: m.apiKey,
      contextWindow: m.contextWindow ?? listed.find(l => l.id === m.id)?.contextWindow,
    })),
  ];
}

export async function listModels(endpoint: string, apiKey: string): Promise<ModelInfo[]> {
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
  const body = await res.json() as unknown;
  const rows = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown[] })?.data) ? (body as { data: unknown[] }).data : [];
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
    const cw = typeof row.context_window === 'number' && row.context_window > 0 ? row.context_window
      : typeof row.max_model_len === 'number' && row.max_model_len > 0 ? row.max_model_len : undefined;
    models.push({ id, name, contextWindow: cw });
  }
  return models;
}
