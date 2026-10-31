// Anthropic Messages 格式 <-> 统一表示（含流式 SSE 转换）
import type {
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamEvent,
  UnifiedMessage,
  UnifiedToolCall,
  UnifiedUsage,
} from './types';

interface ClaudeContentBlock {
  type: string;
  [k: string]: unknown;
}

export interface ClaudeRequest {
  model: string;
  messages: Array<{ role: string; content: string | ClaudeContentBlock[] }>;
  system?: string | ClaudeContentBlock[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  tool_choice?: unknown;
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
  stream?: boolean;
}

export function toUnified(req: ClaudeRequest): UnifiedRequest {
  const messages: UnifiedMessage[] = [];
  // system 提取为 system 消息
  if (req.system) {
    const sysText =
      typeof req.system === 'string'
        ? req.system
        : (req.system as ClaudeContentBlock[])
            .map((b) => (b.type === 'text' ? (b.text as string) : ''))
            .join('\n');
    if (sysText) messages.push({ role: 'system', content: sysText });
  }
  for (const m of req.messages || []) {
    const blocks: ClaudeContentBlock[] =
      typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (m.role === 'assistant') {
      const msg: UnifiedMessage = { role: 'assistant', content: '' };
      const toolCalls: UnifiedToolCall[] = [];
      let text = '';
      let reasoning = '';
      for (const b of blocks) {
        if (b.type === 'text') text += b.text as string;
        else if (b.type === 'thinking') reasoning += b.thinking as string;
        else if (b.type === 'tool_use')
          toolCalls.push({
            id: b.id as string,
            type: 'function',
            function: { name: b.name as string, arguments: JSON.stringify(b.input ?? {}) },
          });
      }
      msg.content = text;
      if (reasoning) msg.reasoning_content = reasoning;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      // user / tool_result
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      if (toolResults.length) {
        for (const tr of toolResults) {
          const content =
            typeof tr.content === 'string'
              ? tr.content
              : JSON.stringify(tr.content);
          messages.push({
            role: 'tool',
            content,
            tool_call_id: tr.tool_use_id as string,
          });
        }
      } else {
        const parts: UnifiedMessage['content'] = [];
        for (const b of blocks) {
          if (b.type === 'text') (parts as any[]).push({ type: 'text', text: b.text as string });
          else if (b.type === 'image')
            (parts as any[]).push({
              type: 'image_url',
              image_url: {
                url: `data:${(b.source as any).media_type};base64,${(b.source as any).data}`,
              },
            });
        }
        messages.push({
          role: m.role === 'user' ? 'user' : 'user',
          content: Array.isArray(parts) && parts.length === 1 && parts[0].type === 'text'
            ? (parts[0] as any).text
            : parts,
        });
      }
    }
  }
  const unified: UnifiedRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    tools: (req.tools || []).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema as any },
    })),
    tool_choice: req.tool_choice,
    thinking: req.thinking,
  };
  return unified;
}

export function fromUnified(req: UnifiedRequest, anthropicVersion = '2023-06-01'): ClaudeRequest {
  const claude: ClaudeRequest = {
    model: req.model,
    messages: [],
    max_tokens: req.max_tokens ?? req.max_completion_tokens ?? 4096,
    temperature: req.temperature,
    top_p: req.top_p,
    tools: (req.tools || []).map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    })),
    tool_choice: req.tool_choice,
    stream: req.stream,
  };
  if (req.thinking) claude.thinking = req.thinking as ClaudeRequest['thinking'];
  for (const m of req.messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      claude.system = text;
      continue;
    }
    if (m.role === 'tool') {
      claude.messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          },
        ],
      });
      continue;
    }
    const blocks: ClaudeContentBlock[] = [];
    if (typeof m.content === 'string') {
      blocks.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text as string });
        else if (part.type === 'image_url') {
          const url = part.image_url.url;
          const comma = url.indexOf(',');
          const header = url.slice(0, comma);
          const data = url.slice(comma + 1);
          const mediaType = header.replace('data:', '').replace(';base64', '');
          blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
        }
      }
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeParse(tc.function.arguments),
        });
      }
    }
    if (m.reasoning_content && m.role === 'assistant') {
      blocks.unshift({ type: 'thinking', thinking: m.reasoning_content });
    }
    claude.messages.push({ role: m.role, content: blocks });
  }
  return claude;
}

export function responseFromUnified(resp: UnifiedResponse): unknown {
  const content: ClaudeContentBlock[] = [];
  const msg = resp.choices[0]?.message;
  if (msg?.reasoning_content) content.push({ type: 'thinking', thinking: msg.reasoning_content });
  if (msg?.content) content.push({ type: 'text', text: msg.content });
  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: safeParse(tc.function.arguments),
      });
    }
  }
  return {
    id: resp.id,
    type: 'message',
    role: 'assistant',
    model: resp.model,
    stop_reason: mapFinishReason(resp.choices[0]?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage.prompt_tokens,
      output_tokens: resp.usage.completion_tokens,
    },
    content,
  };
}

function mapFinishReason(r: string | null | undefined): string {
  switch (r) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    default:
      return 'end_turn';
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────
// 流式：Claude SSE -> 统一事件
// ─────────────────────────────────────────────
export function parseClaudeSSE(
  raw: string,
  ctx: { id: string; model: string }
): UnifiedStreamEvent[] {
  const events: UnifiedStreamEvent[] = [];
  const lines = raw.split('\n');
  let textAcc = '';
  let thinkAcc = '';
  let toolAcc = '';
  let toolName = '';
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
    if (ev.type === 'content_block_delta') {
      const d = ev.delta;
      if (d.type === 'text_delta') textAcc += d.text;
      else if (d.type === 'thinking_delta') thinkAcc += d.thinking;
      else if (d.type === 'input_json_delta') toolAcc += d.partial_json;
    } else if (ev.type === 'content_block_start') {
      if (ev.content_block?.type === 'tool_use') {
        toolName = ev.content_block.name;
        toolId = ev.content_block.id;
        toolAcc = '';
      }
    } else if (ev.type === 'message_delta') {
      if (ev.usage) {
        usage = {
          prompt_tokens: 0,
          completion_tokens: ev.usage.output_tokens ?? 0,
          total_tokens: ev.usage.output_tokens ?? 0,
        };
      }
    }
  }
  const delta: UnifiedStreamEvent['choices'][0]['delta'] = {};
  if (textAcc) delta.content = textAcc;
  if (thinkAcc) delta.reasoning_content = thinkAcc;
  if (toolAcc) {
    delta.tool_calls = [
      { index: 0, id: toolId, type: 'function', function: { name: toolName, arguments: toolAcc } },
    ];
  }
  events.push({
    id: ctx.id,
    model: ctx.model,
    created: Math.floor(Date.now() / 1000),
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: null }],
    usage,
  });
  return events;
}

// ─────────────────────────────────────────────
// 流式：统一事件 -> Claude SSE
// ─────────────────────────────────────────────
export function encodeClaudeSSE(ev: UnifiedStreamEvent): string {
  const out: string[] = [];
  const delta = ev.choices[0]?.delta;
  if (delta?.content) {
    out.push(
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } })
    );
  }
  if (delta?.reasoning_content) {
    out.push(
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } })
    );
  }
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.id) out.push(sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tc.id, name: tc.function?.name ?? '' } }));
      if (tc.function?.arguments) out.push(sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }));
      if (ev.choices[0].finish_reason === 'tool_calls') out.push(sse({ type: 'content_block_stop', index: 0 }));
    }
  }
  if (ev.usage) {
    out.push(
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: ev.usage.completion_tokens } })
    );
  }
  return out.join('');
}

function sse(obj: { type: string; [k: string]: unknown }): string {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
}
