// Google Gemini generateContent 格式 <-> 统一表示（含流式转换）
import type {
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamEvent,
  UnifiedMessage,
  UnifiedToolCall,
  UnifiedUsage,
} from './types';

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
}
interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: Record<string, unknown>;
  tools?: Array<{ functionDeclarations: unknown[] }>;
  [k: string]: unknown;
}

export function toUnified(req: GeminiRequest): UnifiedRequest {
  const messages: UnifiedMessage[] = [];
  if (req.systemInstruction?.parts) {
    const t = req.systemInstruction.parts.map((p) => p.text || '').join('\n');
    if (t) messages.push({ role: 'system', content: t });
  }
  for (const c of req.contents || []) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const msg: UnifiedMessage = { role, content: '' };
    const toolCalls: UnifiedToolCall[] = [];
    for (const p of c.parts || []) {
      if (p.text) msg.content = (msg.content as string) + p.text;
      else if (p.inline_data)
        (msg.content as any) = [
          { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } },
        ];
      else if (p.functionCall)
        toolCalls.push({
          id: 'call_' + p.functionCall.name,
          type: 'function',
          function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
        });
      else if (p.functionResponse)
        messages.push({
          role: 'tool',
          content: JSON.stringify(p.functionResponse.response),
          tool_call_id: p.functionResponse.name,
        });
    }
    if (toolCalls.length) msg.tool_calls = toolCalls;
    messages.push(msg);
  }
  const gc = req.generationConfig || {};
  return {
    model: (req as any).model || '',
    messages,
    temperature: gc.temperature as number,
    top_p: gc.topP as number,
    max_tokens: gc.maxOutputTokens as number,
    tools: (req.tools || []).flatMap((t: any) =>
      (t.functionDeclarations || []).map((f: any) => ({
        type: 'function',
        function: { name: f.name, description: f.description || '', parameters: f.parameters || {} },
      }))
    ),
  };
}

export function fromUnified(req: UnifiedRequest): GeminiRequest {
  const contents: GeminiContent[] = [];
  let systemInstruction: { parts: GeminiPart[] } | undefined;
  for (const m of req.messages) {
    if (m.role === 'system') {
      systemInstruction = {
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      };
      continue;
    }
    const parts: GeminiPart[] = [];
    if (typeof m.content === 'string' && m.content) parts.push({ text: m.content });
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') parts.push({ text: p.text as string });
        else if (p.type === 'image_url') {
          const url = p.image_url.url;
          const comma = url.indexOf(',');
          const mime = url.slice(5, comma).replace(';base64', '');
          const data = url.slice(comma + 1);
          parts.push({ inline_data: { mime_type: mime, data } });
        }
      }
    }
    if (m.role === 'tool') {
      parts.push({
        functionResponse: { name: m.tool_call_id || 'tool', response: safeParse(m.content as string) },
      });
      contents.push({ role: 'user', parts });
      continue;
    }
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        parts.push({ functionCall: { name: tc.function.name, args: safeParse(tc.function.arguments) } });
      }
    }
    if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  const gemini: GeminiRequest = { contents };
  if (systemInstruction) gemini.systemInstruction = systemInstruction;
  if (req.tools?.length) {
    gemini.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      },
    ];
  }
  gemini.generationConfig = {
    temperature: req.temperature,
    topP: req.top_p,
    maxOutputTokens: req.max_tokens ?? req.max_completion_tokens,
  };
  return gemini;
}

export function responseFromUnified(resp: UnifiedResponse): unknown {
  const msg = resp.choices[0]?.message;
  const parts: GeminiPart[] = [];
  if (msg?.content) parts.push({ text: msg.content });
  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      parts.push({ functionCall: { name: tc.function.name, args: safeParse(tc.function.arguments) } });
    }
  }
  return {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: mapFinish(resp.choices[0]?.finish_reason),
      },
    ],
    usageMetadata: {
      promptTokenCount: resp.usage.prompt_tokens,
      candidatesTokenCount: resp.usage.completion_tokens,
      totalTokenCount: resp.usage.total_tokens,
    },
  };
}

function mapFinish(r: string | null | undefined): string {
  switch (r) {
    case 'length':
      return 'MAX_TOKENS';
    case 'tool_calls':
      return 'STOP';
    default:
      return 'STOP';
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
// 流式：Gemini chunk (JSON 对象) -> 统一事件
// Gemini 流式为一系列 GenerateContentResponse JSON 对象
// ─────────────────────────────────────────────
export function parseGeminiChunk(raw: string, ctx: { id: string; model: string }): UnifiedStreamEvent[] {
  const events: UnifiedStreamEvent[] = [];
  let buf = raw.trim();
  // 尝试按多个 JSON 对象切分
  const objs: any[] = [];
  let depth = 0,
    start = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (buf[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          objs.push(JSON.parse(buf.slice(start, i + 1)));
        } catch {
          /* ignore */
        }
        start = -1;
      }
    }
  }
  for (const o of objs) {
    const cand = o.candidates?.[0];
    const delta: UnifiedStreamEvent['choices'][0]['delta'] = {};
    let finish: string | null = null;
    if (cand?.content?.parts) {
      for (const p of cand.content.parts) {
        if (p.text) delta.content = (delta.content || '') + p.text;
        else if (p.functionCall)
          delta.tool_calls = [
            { index: 0, id: 'call_' + p.functionCall.name, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } },
          ];
      }
    }
    if (cand?.finishReason) finish = cand.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
    let usage: UnifiedUsage | undefined;
    if (o.usageMetadata) {
      usage = {
        prompt_tokens: o.usageMetadata.promptTokenCount ?? 0,
        completion_tokens: o.usageMetadata.candidatesTokenCount ?? 0,
        total_tokens: o.usageMetadata.totalTokenCount ?? 0,
      };
    }
    events.push({
      id: ctx.id,
      model: ctx.model,
      created: Math.floor(Date.now() / 1000),
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage,
    });
  }
  return events;
}

// ─────────────────────────────────────────────
// 流式：统一事件 -> Gemini 流（输出单个 JSON 对象 + 换行）
// ─────────────────────────────────────────────
export function encodeGeminiChunk(ev: UnifiedStreamEvent): string {
  const delta = ev.choices[0]?.delta;
  const parts: GeminiPart[] = [];
  if (delta?.content) parts.push({ text: delta.content });
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.function?.name)
        parts.push({ functionCall: { name: tc.function.name, args: safeParse(tc.function.arguments || '{}') } });
    }
  }
  const obj: any = { candidates: [{ content: { role: 'model', parts }, finishReason: ev.choices[0]?.finish_reason === 'length' ? 'MAX_TOKENS' : undefined, index: 0 }] };
  if (ev.usage) {
    obj.usageMetadata = {
      promptTokenCount: ev.usage.prompt_tokens,
      candidatesTokenCount: ev.usage.completion_tokens,
      totalTokenCount: ev.usage.total_tokens,
    };
  }
  return JSON.stringify(obj) + '\n';
}
