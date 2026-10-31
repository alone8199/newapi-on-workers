// 上游代理：构造上游请求、流式/非流式转发、Bedrock SigV4 签名、流式计费捕获
import { Env } from './config';
import { ChannelRow, channelToProtocol, getChannelKeys, pickKey, ChannelType } from './channels';
import {
  toUnifiedRequest,
  fromUnifiedResponse,
  parseTargetResponse,
  createStreamConverter,
} from './protocols/convert';
import * as openai from './protocols/openai';
import * as claude from './protocols/claude';
import * as gemini from './protocols/gemini';
import type { UnifiedRequest, ProtocolName } from './protocols/types';
import { estimateMessagesTokens } from './utils';

export interface ProxyParams {
  env: Env;
  source: ProtocolName; // 客户端协议
  channel: ChannelRow;
  model: string;
  clientBody: any; // 客户端原始请求体
  authCtx: { userId: number; tokenId: number; groupId: string; unlimited: boolean };
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
  onFinish?: (success: boolean, latencyMs: number) => void;
}

function buildNativeRequest(target: ProtocolName, unified: UnifiedRequest, channel: ChannelRow, model: string, key: string) {
  const body = (() => {
    switch (target) {
      case 'openai':
        return openai.fromUnified(unified);
      case 'claude':
        return claude.fromUnified(unified);
      case 'gemini':
        return gemini.fromUnified(unified);
      default:
        return openai.fromUnified(unified);
    }
  })();

  let url: string;
  const headers = new Headers();
  headers.set('content-type', 'application/json');

  if (channel.type === ChannelType.AZURE) {
    // Azure：base_url 形如 https://xxx.openai.azure.com，路径含 deployment
    const apiVersion = (JSON.parse(channel.other || '{}').ApiVersion) || '2024-02-15-preview';
    url = `${channel.base_url.replace(/\/$/, '')}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`;
    headers.set('api-key', key);
  } else if (target === 'claude') {
    url = `${channel.base_url.replace(/\/$/, '')}/v1/messages`;
    headers.set('x-api-key', key);
    headers.set('anthropic-version', '2023-06-01');
  } else if (target === 'gemini') {
    const alt = unified.stream ? 'alt=sse' : '';
    url = `${channel.base_url.replace(/\/$/, '')}/v1beta/models/${model}:${unified.stream ? 'streamGenerateContent?' + alt : 'generateContent'}?key=${key}`;
  } else if (channel.type === ChannelType.BEDROCK) {
    // Bedrock：使用 Anthropic 格式经 invokeModel
    url = `${channel.base_url.replace(/\/$/, '')}/model/${model}/invoke`;
    headers.set('accept', 'application/json');
    headers.set('content-type', 'application/json');
    return { url, headers, body: claude.fromUnified(unified), signBedrock: true };
  } else {
    // OpenAI 兼容（含 Ollama/vLLM/SGLang）
    url = `${channel.base_url.replace(/\/$/, '')}/v1/chat/completions`;
    headers.set('authorization', `Bearer ${key}`);
  }
  return { url, headers, body };
}

/** 主代理入口 */
export async function proxyChat(params: ProxyParams): Promise<Response> {
  const { env, source, channel, model, clientBody, authCtx } = params;
  const unified: UnifiedRequest = toUnifiedRequest(clientBody, source);
  unified.model = model;
  const target = channelToProtocol(channel.type);
  const keys = await getChannelKeys(channel, env);
  if (!keys.length) return new Response(JSON.stringify({ error: { message: '渠道无可用 Key', type: 'channel_error' } }), { status: 500 });
  const key = pickKey(keys);
  const built = buildNativeRequest(target, unified, channel, model, key);

  const started = Date.now();
  const init: RequestInit = {
    method: 'POST',
    headers: built.headers,
    body: JSON.stringify(built.body),
  };
  let upstream: Response;
  try {
    if (built.signBedrock) {
      await signAWS(init as any, channel, env, built.url, JSON.stringify(built.body));
    }
    upstream = await fetch(built.url, init);
  } catch (e) {
    params.onFinish?.(false, Date.now() - started);
    return new Response(JSON.stringify({ error: { message: '上游连接失败: ' + String(e), type: 'upstream_error' } }), { status: 502 });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    params.onFinish?.(false, Date.now() - started);
    return new Response(
      JSON.stringify({ error: { message: `上游错误 ${upstream.status}: ${text.slice(0, 500)}`, type: 'upstream_error' } }),
      { status: upstream.status }
    );
  }

  // 非流式
  if (!unified.stream) {
    const json = await upstream.json().catch(() => null);
    if (!json) {
      params.onFinish?.(false, Date.now() - started);
      return new Response(JSON.stringify({ error: { message: '上游返回非 JSON', type: 'upstream_error' } }), { status: 502 });
    }
    const resp = parseTargetResponse(target, json);
    params.onUsage?.(resp.usage);
    params.onFinish?.(true, Date.now() - started);
    const out = fromUnifiedResponse(resp, source);
    return new Response(JSON.stringify(out), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  // 流式：target -> 统一事件 -> source，并捕获 usage
  let capturedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let gotUsage = false;
  const converter = createStreamConverter(target, source, { id: 'chatcmpl-' + Math.random().toString(36).slice(2), model }, (ev) => {
    if (ev.usage && (ev.usage.total_tokens > 0)) {
      capturedUsage = ev.usage;
      gotUsage = true;
    }
  });
  const converted = upstream.body!.pipeThrough(converter);

  // 包装流：结束/断开时结算计费
  const reader = converted.getReader();
  const finish = (success: boolean) => {
    if (gotUsage || success) params.onUsage?.(capturedUsage);
    params.onFinish?.(success, Date.now() - started);
  };
  const outStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        finish(true);
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      finish(false);
      reader.cancel();
    },
  });
  const ct = source === 'gemini' ? 'application/json' : 'text/event-stream; charset=utf-8';
  return new Response(outStream, {
    headers: { 'content-type': ct, 'cache-control': 'no-store', connection: 'keep-alive' },
  });
}

/** AWS SigV4 签名（Bedrock invokeModel 最小实现，异步 WebCrypto） */
async function signAWS(init: RequestInit, channel: ChannelRow, env: Env, url: string, payload: string): Promise<void> {
  const other = JSON.parse(channel.other || '{}');
  const region = other.Region || 'us-east-1';
  const ak = env.AWS_ACCESS_KEY_ID || other.AccessKeyId || '';
  const sk = env.AWS_SECRET_ACCESS_KEY || other.SecretAccessKey || '';
  const u = new URL(url);
  const service = 'bedrock';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 17);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(payload);
  const canonicalHeaders = `host:${u.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `POST\n${u.pathname}\n${u.search}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;
  const kDate = await hmacSha256(`AWS4${sk}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = toHex(await hmacSha256(kSigning, stringToSign));
  const authHeader = `${algorithm} Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  (init.headers as Headers).set('x-amz-date', amzDate);
  (init.headers as Headers).set('x-amz-content-sha256', payloadHash);
  (init.headers as Headers).set('authorization', authHeader);
}

async function sha256Hex(msg: string): Promise<string> {
  const bytes = new TextEncoder().encode(msg);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}
async function hmacSha256(key: string | Uint8Array, msg: string): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 估算预扣额度（基于 max_tokens） */
export function estimatePreQuota(clientBody: any): number {
  const maxTokens = clientBody.max_tokens || clientBody.max_completion_tokens || 1024;
  const prompt = estimateMessagesTokens(clientBody.messages || []);
  return Math.ceil((prompt + maxTokens) * 2); // 粗略上限
}
