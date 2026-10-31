# NewAPI on Cloudflare Workers

将 [NewAPI](https://github.com/Calcium-Ion/New-API)（One API 二次开发分支）完整重写为 Cloudflare Workers 版本。目标三层一致：**协议层、管理 API 层、界面层**。

最高原则：**不设限**——能实现的全部实现；需要额外 Cloudflare 能力（Durable Objects / Queues / Cron）就引入；物理上无法实现则用最接近替代方案并标注 `// LIMITATION`。

## 架构

详见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。要点：

- **协议转换矩阵**：OpenAI Chat / Claude Messages / Gemini / OpenAI Responses 四种协议双向转换，流式逐 chunk 转换，保留工具调用、推理内容、多模态与 usage。
- **存储**：D1 为权威（users/tokens/channels/logs/tasks/额度），KV 为缓存与配置（Options/Session/模型列表），Durable Objects 用于 WebSocket 托管与高频额度聚合。
- **异步任务**：Midjourney / Suno / 视频任务型端点经 Queues + Cron 驱动状态轮询，客户端查询直读 D1。
- **WebSocket**：OpenAI Realtime / Responses WebSocket 经 Durable Object 托管（Hibernation）。

## 目录

```
src/             Worker 后端（TypeScript）
  index.ts       入口：路由 / Cron / Queue / 静态托管
  protocols/     四种协议 + 转换矩阵（流式逐 chunk）
  routes/        /v1 /pg /api /tasks 端点
  storage/       D1 schema / KV 封装 / Session
  billing.ts     预扣/结算/退款（D1 条件更新 + DO 聚合）
  proxy.ts       上游代理（流式/非流式 + Bedrock SigV4）
do/              RelayDurableObject（WS）/ QuotaAggregatorDO（额度聚合）
queues/          TASK_QUEUE 消费器（任务轮询/回调）
tests/           协议转换单元测试
frontend/        前端集成部署脚本 + 体积实测
public/          原版前端构建产物（SPA fallback）
```

## 快速开始

```bash
npm install
# 1. 创建绑定（KV / D1 / DO / Queues），填入 wrangler.toml
wrangler kv namespace create NEWAPI_KV
wrangler d1 create newapi_db
wrangler deploy  # 创建 DO 类与 Queue
# 2. 初始化数据库
wrangler d1 execute NEWAPI_DB --remote --file=src/storage/migrations.sql
# 3. 部署前端
bash frontend/deploy.sh
wrangler deploy
```

## 端点覆盖

| 分类 | 端点 |
|---|---|
| OpenAI | `/v1/chat/completions` `/v1/completions` `/v1/embeddings` `/v1/models` `/v1/images/*` `/v1/audio/*` `/v1/rerank` `/v1/moderations` `/v1/responses` |
| Claude | `/v1/messages` `/v1/messages/count_tokens` |
| Gemini | `/v1beta/models/{model}:generateContent` `/:streamGenerateContent` |
| 游乐场 | `/pg/chat/completions` |
| 任务型 | `/v1/mj/submit/*` `/v1/suno/*` `/v1/video/*` + 查询 |
| 管理 | `/api/user/*` `/api/token/*` `/api/channel/*` `/api/log/*` `/api/option/*` `/api/redemption/*` `/api/group/*` `/api/pricing/*` `/api/model/*` |
| WS | `/v1/realtime` `/v1/responses/ws` |

## 已知限制（LIMITATION）

- Midjourney 官方 WS 推送 → 以 Queues 轮询替代。
- Bedrock 需要 AWS SigV4（已实现异步 WebCrypto 签名）。
- 密码哈希用 PBKDF2-SHA256 替代 bcrypt（等价替代）。
- 渠道 key 以 AES-GCM（MASTER_KEY）静态加密存储，不存明文。

详见 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 第 12 节 LIMITATION 清单。
