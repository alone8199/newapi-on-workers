// OpenAI Chat Completions 格式 <-> 统一表示
// OpenAI 结构与统一表示最接近，主要处理 content 部分与 tool_calls 的形状差异
import type {
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamEvent,
  UnifiedMessage,
  UnifiedToolCall,
} from './types';

export interface OpenAIChatRequest {
  model: string;
  messages: Array<{
    role: string;
    content: unknown;
    name?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: unknown[];
  tool_choice?: unknown;
  [k: string]: unknown;
}

export function toUnified(req: OpenAIChatRequest): UnifiedRequest {
  const messages: UnifiedMessage[] = (req.messages || []).map((m) => ({
    role: m.role as UnifiedMessage['role'],
    content: m.content as UnifiedMessage['content'],
    name: m.name,
    tool_calls: (m.tool_calls as UnifiedToolCall[]) || undefined,
    tool_call_id: m.tool_call_id,
  }));
  return {
    model: req.model,
    messages,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    stream: req.stream,
    stream_options: req.stream_options,
    tools: req.tools as UnifiedRequest['tools'],
    tool_choice: req.tool_choice,
  };
}

export function fromUnified(req: UnifiedRequest): OpenAIChatRequest {
  return {
    model: req.model,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: m.content,
      name: m.name,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
    })),
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    stream: req.stream,
    stream_options: req.stream_options,
    tools: req.tools,
    tool_choice: req.tool_choice,
  };
}

/** 非流式响应：统一表示 -> OpenAI 响应 */
export function responseToOpenAI(resp: UnifiedResponse): unknown {
  return resp;
}

/** 流式 chunk：统一事件 -> OpenAI chunk */
export function streamEventToOpenAI(ev: UnifiedStreamEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}
