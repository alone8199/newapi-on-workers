// 四种协议（OpenAI Chat / Claude Messages / Gemini / OpenAI Responses）的统一内部表示
// 转换矩阵：每种协议负责「本协议 ↔ 统一表示」的差量映射，A→B 走 A→统一→B

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface UnifiedTextPart {
  type: 'text';
  text: string;
}
export interface UnifiedImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: string };
}
export interface UnifiedAudioPart {
  type: 'input_audio';
  input_audio: { data: string; format: string };
}
export type UnifiedPart = UnifiedTextPart | UnifiedImagePart | UnifiedAudioPart;

export type UnifiedContent = string | UnifiedPart[];

export interface UnifiedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface UnifiedTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface UnifiedMessage {
  role: Role;
  content: UnifiedContent;
  name?: string;
  tool_calls?: UnifiedToolCall[];
  tool_call_id?: string;
  // Anthropic 推理内容（extended thinking）
  reasoning_content?: string;
}

export interface UnifiedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface UnifiedRequest {
  model: string;
  messages: UnifiedMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: UnifiedTool[];
  tool_choice?: unknown;
  // OpenAI reasoning / Anthropic thinking
  reasoning_effort?: string;
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
  // 通用透传字段
  [key: string]: unknown;
}

export interface UnifiedResponse {
  id: string;
  model: string;
  created: number;
  object: 'chat.completion';
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: UnifiedToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage: UnifiedUsage;
}

// 流式事件（chat.completion.chunk 形状的统一表示）
export interface UnifiedStreamEvent {
  id: string;
  model: string;
  created: number;
  object: 'chat.completion.chunk';
  choices: Array<{
    index: number;
    delta: {
      role?: Role;
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: UnifiedUsage;
}

export type ProtocolName = 'openai' | 'claude' | 'gemini' | 'responses';
