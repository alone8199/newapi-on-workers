// 协议转换矩阵：每种协议对（source → target）一个路径，组合为「源→统一→目标」
// 流式：逐 chunk 转换（不缓冲完整响应），见 ARCHITECTURE.md §5.3
import type { UnifiedRequest, UnifiedResponse, UnifiedStreamEvent, ProtocolName } from './types';
import * as openai from './openai';
import * as claude from './claude';
import * as gemini from './gemini';
import * as responses from './responses';

// ─────────────────────────────────────────────
// 请求：原生 -> 统一
// ─────────────────────────────────────────────
export function toUnifiedRequest(body: any, source: ProtocolName): UnifiedRequest {
  switch (source) {
    case 'openai':
      return openai.toUnified(body as openai.OpenAIChatRequest);
    case 'claude':
      return claude.toUnified(body as claude.ClaudeRequest);
    case 'gemini':
      return gemini.toUnified(body as gemini.GeminiRequest);
    case 'responses':
      return responses.toUnified(body as responses.ResponsesRequest);
  }
}

// ─────────────────────────────────────────────
// 响应：统一 -> 原生（非流式）
// ─────────────────────────────────────────────
export function fromUnifiedResponse(resp: UnifiedResponse, target: ProtocolName): unknown {
  switch (target) {
    case 'openai':
      return openai.responseToOpenAI(resp);
    case 'claude':
      return claude.responseFromUnified(resp);
    case 'gemini':
      return gemini.responseFromUnified(resp);
    case 'responses':
      return responses.fromUnified(resp);
  }
}

// ─────────────────────────────────────────────
// 流式转换器：源协议 -> 统一事件 -> 目标协议
// 返回 TransformStream<Uint8Array, Uint8Array>
// ─────────────────────────────────────────────
export function createStreamConverter(
  source: ProtocolName,
  target: ProtocolName,
  ctx: { id: string; model: string },
  onEvent?: (ev: UnifiedStreamEvent) => void
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const parseSource = (text: string): UnifiedStreamEvent[] => {
    switch (source) {
      case 'openai':
        return parseOpenAISSE(text, ctx);
      case 'claude':
        return claude.parseClaudeSSE(text, ctx);
      case 'gemini':
        return gemini.parseGeminiChunk(text, ctx);
      case 'responses':
        return responses.parseResponsesSSE(text, ctx);
    }
  };

  const encodeTarget = (ev: UnifiedStreamEvent): string => {
    switch (target) {
      case 'openai':
        return openai.streamEventToOpenAI(ev);
      case 'claude':
        return claude.encodeClaudeSSE(ev);
      case 'gemini':
        return gemini.encodeGeminiChunk(ev);
      case 'responses':
        return responses.encodeResponsesSSE(ev);
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const emit = (events: UnifiedStreamEvent[]) => {
        for (const ev of events) {
          if (onEvent) onEvent(ev);
          controller.enqueue(encoder.encode(encodeTarget(ev)));
        }
      };
      if (source === 'gemini') {
        // Gemini 流式为裸 JSON 对象（可能多个），按完整对象切分
        const { objs, rest } = splitJsonObjects(buffer);
        buffer = rest;
        for (const o of objs) emit(parseGeminiSingle(JSON.stringify(o), ctx));
      } else {
        // SSE 协议：以空行(\n\n)切分完整事件块
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const msg = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (msg.trim()) emit(parseSource(msg + '\n'));
        }
      }
    },
    flush(controller) {
      const tail = buffer.trim();
      if (tail) {
        const events = parseSource(tail + (source === 'gemini' ? '' : '\n'));
        for (const ev of events) {
          if (onEvent) onEvent(ev);
          controller.enqueue(encoder.encode(encodeTarget(ev)));
        }
      }
      buffer = '';
      if (target === 'openai' || target === 'responses') {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      }
    },
  });
}

// ── 解析单段 OpenAI SSE 为统一事件 ──
function parseOpenAISSE(text: string, ctx: { id: string; model: string }): UnifiedStreamEvent[] {
  const events: UnifiedStreamEvent[] = [];
  const lines = text.split('\n');
  const datas: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      datas.push(line.slice(5).trim());
    }
  }
  for (const d of datas) {
    if (!d || d === '[DONE]') continue;
    let obj: any;
    try {
      obj = JSON.parse(d);
    } catch {
      continue;
    }
    const ev: UnifiedStreamEvent = {
      id: obj.id ?? ctx.id,
      model: obj.model ?? ctx.model,
      created: obj.created ?? Math.floor(Date.now() / 1000),
      object: 'chat.completion.chunk',
      choices: obj.choices ?? [{ index: 0, delta: {}, finish_reason: null }],
      usage: obj.usage,
    };
    events.push(ev);
  }
  return events;
}

// ── Gemini 裸 JSON 对象切分 ──
function splitJsonObjects(buffer: string): { objs: any[]; rest: string } {
  const objs: any[] = [];
  let depth = 0,
    start = -1,
    inStr = false,
    esc = false;
  let i = 0;
  for (; i < buffer.length; i++) {
    const c = buffer[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          objs.push(JSON.parse(buffer.slice(start, i + 1)));
        } catch {
          /* ignore */
        }
        start = -1;
      }
    }
  }
  return { objs, rest: start >= 0 ? buffer.slice(start) : buffer.slice(i) };
}

function parseGeminiSingle(o: any, ctx: { id: string; model: string }): UnifiedStreamEvent[] {
  // 复用 gemini.parseGeminiChunk，但传入单对象字符串
  return gemini.parseGeminiChunk(JSON.stringify(o), ctx);
}

// ─────────────────────────────────────────────
// 响应：原生 -> 统一（非流式解析）
// ─────────────────────────────────────────────
export function parseTargetResponse(target: ProtocolName, body: any): UnifiedResponse {
  const base: UnifiedResponse = {
    id: body.id ?? 'chatcmpl-' + crypto.randomUUID().slice(0, 8),
    model: body.model ?? '',
    created: body.created ?? Math.floor(Date.now() / 1000),
    object: 'chat.completion',
    choices: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  switch (target) {
    case 'openai':
    case 'responses': {
      const msg = body.choices?.[0]?.message;
      const u = body.usage;
      base.choices = [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: msg?.content ?? null,
            reasoning_content: msg?.reasoning_content,
            tool_calls: msg?.tool_calls,
          },
          finish_reason: body.choices?.[0]?.finish_reason ?? null,
        },
      ];
      if (u) base.usage = { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0, total_tokens: u.total_tokens ?? 0 };
      return base;
    }
    case 'claude': {
      const c = body.content || [];
      let text = '';
      let reasoning = '';
      const toolCalls: any[] = [];
      for (const b of c) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'thinking') reasoning += b.thinking;
        else if (b.type === 'tool_use')
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      }
      const u = body.usage;
      base.choices = [
        {
          index: 0,
          message: { role: 'assistant', content: text || null, reasoning_content: reasoning || undefined, tool_calls: toolCalls.length ? toolCalls : undefined },
          finish_reason: body.stop_reason === 'tool_use' ? 'tool_calls' : body.stop_reason === 'max_tokens' ? 'length' : 'stop',
        },
      ];
      if (u) base.usage = { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) };
      return base;
    }
    case 'gemini': {
      const cand = body.candidates?.[0];
      let text = '';
      const toolCalls: any[] = [];
      for (const p of cand?.content?.parts || []) {
        if (p.text) text += p.text;
        else if (p.functionCall) toolCalls.push({ id: 'call_' + p.functionCall.name, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } });
      }
      const u = body.usageMetadata;
      base.choices = [
        {
          index: 0,
          message: { role: 'assistant', content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined },
          finish_reason: cand?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
        },
      ];
      if (u) base.usage = { prompt_tokens: u.promptTokenCount ?? 0, completion_tokens: u.candidatesTokenCount ?? 0, total_tokens: u.totalTokenCount ?? 0 };
      return base;
    }
  }
}

// ─────────────────────────────────────────────
// 协议识别（路由层使用）
// ─────────────────────────────────────────────
export function detectProtocol(pathname: string): ProtocolName | null {
  if (pathname.startsWith('/v1/messages')) return 'claude';
  if (pathname.includes('gemini') || pathname.includes('generativelanguage')) return 'gemini';
  if (pathname.startsWith('/v1/responses')) return 'responses';
  if (pathname.startsWith('/v1/chat') || pathname.startsWith('/v1/completions') || pathname.startsWith('/v1/models')) return 'openai';
  return null;
}

export type { UnifiedRequest, UnifiedResponse, UnifiedStreamEvent, ProtocolName } from './types';
