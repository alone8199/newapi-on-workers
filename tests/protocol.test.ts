import { describe, it, expect } from 'vitest';
import * as openai from '../src/protocols/openai';
import * as claude from '../src/protocols/claude';
import * as gemini from '../src/protocols/gemini';
import * as responses from '../src/protocols/responses';
import { toUnifiedRequest, fromUnifiedResponse, parseTargetResponse, createStreamConverter } from '../src/protocols/convert';

const ctx = { id: 't1', model: 'gpt-4o' };

describe('OpenAI <-> Claude 请求转换', () => {
  it('OpenAI 请求 -> 统一 -> Claude 请求（保留 system/tools/多模态）', () => {
    const oa: any = {
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'system', content: '你是个助手' },
        { role: 'user', content: [{ type: 'text', text: '你好' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: '天气', parameters: { type: 'object' } } }],
      max_tokens: 1024,
    };
    const unified = toUnifiedRequest(oa, 'openai');
    const cl = claude.fromUnified(unified);
    expect(cl.system).toBe('你是个助手');
    expect(cl.max_tokens).toBe(1024);
    // 多模态转 image 块
    const userMsg = cl.messages.find((m) => m.role === 'user');
    expect((userMsg!.content as any[]).some((b) => b.type === 'image')).toBe(true);
    // tool 转 function_declarations
    expect(cl.tools![0].name).toBe('get_weather');
  });

  it('Claude 流式 SSE -> 统一事件（保留文本与 tool_use）', () => {
    const sse = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}',
    ].join('\n');
    const events = claude.parseClaudeSSE(sse, ctx);
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.choices[0].delta.content).toContain('你好');
    expect(last.choices[0].delta.tool_calls?.[0].function?.arguments).toContain('a');
  });
});

describe('OpenAI <-> Gemini 转换', () => {
  it('Gemini 请求 -> 统一 -> OpenAI（system + 角色映射）', () => {
    const gm: any = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: 'sys' }] },
    };
    const unified = toUnifiedRequest(gm, 'gemini');
    expect(unified.messages[0].role).toBe('system');
    expect(unified.messages[1].role).toBe('user');
    const oa = openai.fromUnified(unified);
    expect(oa.messages[0].role).toBe('system');
    expect(oa.messages[1].content).toBe('hi');
  });

  it('Gemini 响应 -> 统一（usage 保留）', () => {
    const resp = gemini.responseFromUnified({
      id: 'x', model: 'gem', created: 1, object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect((resp as any).usageMetadata.totalTokenCount).toBe(15);
  });
});

describe('OpenAI <-> Responses 转换', () => {
  it('Responses 输入 -> 统一 -> OpenAI（tool 映射）', () => {
    const rs: any = {
      model: 'gpt-4o',
      instructions: '指令',
      input: [
        { role: 'user', type: 'message', content: '你好' },
        { type: 'function_call_output', call_id: 'c1', output: '结果' },
      ],
    };
    const unified = toUnifiedRequest(rs, 'responses');
    expect(unified.messages[0].content).toBe('指令');
    expect(unified.messages[1].role).toBe('user');
    expect(unified.messages[2].role).toBe('tool');
    expect(unified.messages[2].tool_call_id).toBe('c1');
  });
});

describe('流式转换器（OpenAI -> Claude）', async () => {
  it('逐 chunk 透传转换不缓冲完整响应', async () => {
    const converter = createStreamConverter('openai', 'claude', ctx);
    const writer = converter.writable.getWriter();
    const reader = converter.readable.getReader();
    const texts: string[] = [];
    writer.write(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
    writer.write(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\n'));
    writer.close();
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) texts.push(new TextDecoder().decode(value));
    }
    const out = texts.join('');
    // 验证逐 chunk 转换（不缓冲完整响应）：两个独立 delta 分别透传
    expect(out).toContain('content_block_delta');
    expect(out).toContain('"text":"你"');
    expect(out).toContain('"text":"好"');
    // 不出现被缓冲合并的 "你好"（证明未缓冲完整响应）
    expect(out).not.toContain('"text":"你好"');
  });
});

describe('统一响应解析（各协议）', () => {
  it('Claude 响应 -> 统一（含 thinking 与 tool_use）', () => {
    const u = parseTargetResponse('claude', {
      content: [
        { type: 'thinking', thinking: '让我想想' },
        { type: 'text', text: '答案' },
        { type: 'tool_use', id: 't1', name: 'fn', input: { a: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    expect(u.choices[0].message.reasoning_content).toBe('让我想想');
    expect(u.choices[0].message.content).toBe('答案');
    expect(u.choices[0].message.tool_calls![0].function.name).toBe('fn');
    expect(u.choices[0].finish_reason).toBe('tool_calls');
  });
});
