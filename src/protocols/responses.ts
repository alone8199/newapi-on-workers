// OpenAI Responses API 格式 <-> 统一表示（含流式事件转换）
import type {
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamEvent,
  UnifiedMessage,
  UnifiedToolCall,
  UnifiedUsage,
} from './types';

interface ResponsesInputItem {
  role?: string;
  type?: string;
  content?: unknown;
  text?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  id?: string;
}

export interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  temperature?: number;
  top_p?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  [k: string]: unknown;
}

export function toUnified(req: ResponsesRequest): UnifiedRequest {
  const messages: UnifiedMessage[] = [];
  if (req.instructions) messages.push({ role: 'system', content: req.instructions });
  const items: ResponsesInputItem[] = Array.isArray(req.input)
    ? req.input
    : [{ role: 'user', type: 'message', content: req.input }];
  for (const it of items) {
    if (it.type === 'message' || it.role === 'user' || it.role === 'assistant' || it.role === 'system') {
      const content =
        typeof it.content === 'string'
          ? it.content
          : it.text
          ? it.text
          : JSON.stringify(it.content ?? '');
      messages.push({ role: (it.role as UnifiedMessage['role']) ?? 'user', content });
    } else if (it.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: it.call_id || it.id || 'call_0', type: 'function', function: { name: it.name || '', arguments: it.arguments || '{}' } },
        ],
      });
    } else if (it.type === 'function_call_output') {
      messages.push({ role: 'tool', content: typeof it.content === 'string' ? it.content : JSON.stringify(it.content ?? ''), tool_call_id: it.call_id });
    }
  }
  return {
    model: req.model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    tools: req.tools as UnifiedRequest['tools'],
    tool_choice: req.tool_choice,
    stream: req.stream,
  };
}

export function fromUnified(resp: UnifiedResponse): unknown {
  const msg = resp.choices[0]?.message;
  const output: unknown[] = [];
  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call',
        id: tc.id,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: 'completed',
      });
    }
  } else {
    output.push({
      type: 'message',
      id: 'msg_' + resp.id,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: msg?.content ?? '', annotations: [] }],
    });
  }
  return {
    id: 'resp_' + resp.id,
    object: 'response',
    created_at: resp.created,
    model: resp.model,
    status: 'completed',
    output,
    usage: {
      input_tokens: resp.usage.prompt_tokens,
      output_tokens: resp.usage.completion_tokens,
      total_tokens: resp.usage.total_tokens,
    },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    temperature: 1,
  };
}

// ─────────────────────────────────────────────
// 流式：统一事件 -> Responses SSE 事件
// ─────────────────────────────────────────────
export function encodeResponsesSSE(ev: UnifiedStreamEvent): string {
  const out: string[] = [];
  const delta = ev.choices[0]?.delta;
  if (delta?.content) {
    out.push(sse('response.output_text.delta', { delta: delta.content }));
  }
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.id) out.push(sse('response.tool_call.created', { item_id: tc.id, name: tc.function?.name }));
      if (tc.function?.arguments) out.push(sse('response.tool_call.delta', { item_id: tc.id, delta: tc.function.arguments }));
      if (ev.choices[0].finish_reason === 'tool_calls') out.push(sse('response.tool_call.done', { item_id: tc.id }));
    }
  }
  if (ev.usage) {
    out.push(
      sse('response.completed', {
        response: {
          status: 'completed',
          usage: {
            input_tokens: ev.usage.prompt_tokens,
            output_tokens: ev.usage.completion_tokens,
            total_tokens: ev.usage.total_tokens,
          },
        },
      })
    );
  }
  return out.join('');
}

// ─────────────────────────────────────────────
// 流式：Responses SSE 事件 -> 统一事件
// ─────────────────────────────────────────────
export function parseResponsesSSE(raw: string, ctx: { id: string; model: string }): UnifiedStreamEvent[] {
  const events: UnifiedStreamEvent[] = [];
  const lines = raw.split('\n');
  let textAcc = '';
  let toolAcc = '';
  let toolId = '';
  let usage: UnifiedUsage | undefined;
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const json = line.slice(5).trim();
    if (!json || json === '[DONE]') continue;
    let ev: any;
    try {
      ev = JSON.parse(json);
    } catch {
      continue;
    }
    if (ev.type === 'response.output_text.delta') textAcc += ev.delta || '';
    else if (ev.type === 'response.tool_call.created') {
      toolId = ev.item_id;
    } else if (ev.type === 'response.tool_call.delta') toolAcc += ev.delta || '';
    else if (ev.type === 'response.completed' && ev.response?.usage) {
      usage = {
        prompt_tokens: ev.response.usage.input_tokens ?? 0,
        completion_tokens: ev.response.usage.output_tokens ?? 0,
        total_tokens: ev.response.usage.total_tokens ?? 0,
      };
    }
  }
  const delta: UnifiedStreamEvent['choices'][0]['delta'] = {};
  if (textAcc) delta.content = textAcc;
  if (toolAcc) delta.tool_calls = [{ index: 0, id: toolId, type: 'function', function: { arguments: toolAcc } }];
  events.push({
    id: ctx.id,
    model: ctx.model,
    created: Math.floor(Date.now() / 1000),
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: usage ? 'stop' : null }],
    usage,
  });
  return events;
}

function sse(type: string, obj: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
}
