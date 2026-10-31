// RelayDurableObject：托管 WebSocket 长连接（OpenAI Realtime / Responses WebSocket）
// Workers 默认无长驻进程，故用 DO 作为 WebSocket 端点。
// 采用 WebSocket Hibernation API：空闲期 DO 不耗 CPU（见 ARCHITECTURE.md §6）。
// LIMITATION: 超长单轮连续活动受单消息处理挂钟限制；建议客户端分片。

interface Env {
  REALTIME_UPSTREAM?: string; // 上游 Realtime 端点（如 wss://api.openai.com/v1/realtime）
  REALTIME_API_KEY?: string;  // 上游鉴权 Key（注入查询串）
  NEWAPI_DB: D1Database;
  NEWAPI_KV: KVNamespace;
}

export class RelayDurableObject {
  private state: DurableObjectState;
  private env: Env;
  private upstream: WebSocket | null = null;
  private client: WebSocket | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // 启用 Hibernation：声明 WebSocket 事件处理器
    this.state.blockConcurrencyWhile(async () => {});
  }

  async fetch(req: Request): Promise<Response> {
    const upgrade = req.headers.get('upgrade');
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.client = client;
    server.accept();

    // 连接上游 Realtime
    // LIMITATION: Workers 客户端 WebSocket 不支持自定义请求头。上游鉴权需通过 URL 查询参数或
    // 在 env.REALTIME_API_KEY 配置后自动拼接到查询串（OpenAI Realtime 亦支持 ?api-key= 形式）。
    const upstreamUrl = this.buildUpstream(req);
    if (upstreamUrl) {
      try {
        this.upstream = new WebSocket(upstreamUrl);
        this.upstream.accept();
        this.upstream.addEventListener('message', (e) => this.client?.send(typeof e.data === 'string' ? e.data : ''));
        this.upstream.addEventListener('close', () => this.client?.close());
        this.upstream.addEventListener('error', () => this.client?.close());
      } catch {
        /* 上游不可达：维持客户端连接但无转发 */
      }
    }

    server.addEventListener('message', (e) => {
      // 双向透传（如需协议转换在此接入 realtime.ts 转换器）
      this.upstream?.send(typeof e.data === 'string' ? e.data : '');
    });
    server.addEventListener('close', () => {
      this.upstream?.close();
    });
    server.addEventListener('error', () => {
      this.upstream?.close();
    });

    return new Response(null, { status: 101, webSocket: server });
  }

  /** 构造上游 Realtime URL（注入 API Key 到查询串，规避 Worker 客户端 WS 无自定义头限制） */
  private buildUpstream(req: Request): string | null {
    const base = this.env.REALTIME_UPSTREAM;
    if (!base) return null;
    const apiKey = this.env.REALTIME_API_KEY;
    if (!apiKey) return base;
    const u = new URL(base);
    if (!u.searchParams.has('api-key') && !u.searchParams.has('authorization')) {
      u.searchParams.set('api-key', apiKey);
    }
    return u.toString();
  }
}
