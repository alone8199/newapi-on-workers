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
  index.ts       入口：路由 / Cron / Queue / 静态托管（回带 X-Oneapi-Request-Id、注入 AUTH_SECRET）
  protocols/     四种协议 + 转换矩阵（流式逐 chunk）
  routes/        /v1 /pg /api /tasks 端点
  storage/       D1 schema / KV 封装
  auth_session.ts 登录会话：access token(JWT) + refresh token + 原版双 Cookie
  options.ts     Options 读取（KV 缓存未命中回退 D1）
  billing.ts     预扣/结算/退款（D1 条件更新 + DO 聚合）
  proxy.ts       上游代理（流式/非流式 + Bedrock SigV4）
do/              RelayDurableObject（WS）/ QuotaAggregatorDO（额度聚合）
queues/          TASK_QUEUE 消费器（任务轮询/回调）
tests/           协议转换单元测试 + miniflare 契约集成测试
compare-api.ts   逐端点 diff 工具（对原版实例实跑）
e2e/             Playwright 界面一致性用例（origin/worker 双 project）
seed.sql         原版与 Worker 共用的固定基准数据
test-report.md   端点/页面覆盖表 + LIMITATION 清单 + 验收结论
frontend/        前端集成部署脚本 + 体积实测
public/          原版前端构建产物（SPA fallback）
```

## 快速开始

```bash
npm install
# 1. 创建绑定（KV / D1 / DO / Queues），填入 wrangler.toml
wrangler kv namespace create NEWAPI_KV
wrangler d1 create newapi_db
# 2. 设置 access token 签名密钥（生产必填）
wrangler secret put AUTH_SECRET     # 本地开发写入 .dev.vars
# 3. 初始化数据库
wrangler d1 execute NEWAPI_DB --remote --file=src/storage/migrations.sql
# 4. 部署前端（把原版 web/dist 放入 public/，不 patch）
bash frontend/deploy.sh
wrangler deploy
```

## 本地全量测试（收尾阶段）

```bash
npm run typecheck     # worker + tests + e2e 三份 tsconfig，0 error
npm test              # 自动重打包 + 19 项测试（7 协议转换 + 12 契约集成）
npm run build         # wrangler deploy --dry-run 打包自检

# 本地起 Worker（另开终端起原版，见 BASELINE.md §1）
wrangler d1 execute NEWAPI_DB --local --file=src/storage/migrations.sql
wrangler d1 execute NEWAPI_DB --local --file=seed.sql
wrangler dev --local --port 8787 --persist-to .wrangler/state

# 对原版实跑逐端点 diff / 界面 E2E
ORIGIN=http://localhost:3000 WORKER=http://localhost:8787 npm run compare
ORIGIN=http://localhost:3000 WORKER=http://localhost:8787 npm run e2e
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

## 与原版契约对齐（收尾阶段已完成）

- 管理 API 一律 `HTTP 200` + `{success,message,data}` 信封（原版前端只认 `success`）。
- 密码 **bcrypt(cost=10)**，与原版 `common/crypto.go` 一致，共用 seed 两边可登录。
- 登录/刷新/登出对齐原版 **access token + refresh token + `new_api_refresh` / `new_api_has_session` 双 Cookie**。
- 渠道列表 `{items,total,page,page_size,type_counts}`，`page_size` 默认 20，字段含 `group`/`key`。
- `/api/user/self` 返回 `buildSelfUserData` 全字段。
- DB 列名对齐 GORM（`"group"` 双引号引用保留字、`logs.channel_id`）。
- `/v1/*` 用 OpenAI 错误对象，额度不足 403，回带 `X-Oneapi-Request-Id`。

详见 [`test-report.md`](./test-report.md)（逐条修复 + 覆盖表 + LIMITATION 清单）。

## 已知限制（LIMITATION）

- `admin_permissions` 细粒度权限表返回 `{}`（菜单可见性已由 `sidebar_modules` 对齐）。
- argon2id 历史密码未支持（seed 与自建账户均为 bcrypt）。
- 登录 2FA / Passkey / OAuth 未移植（密码登录可用）。
- Realtime WS 无法透传自定义 Authorization 头 → 鉴权走 URL query。
- Midjourney 官方 WS 推送 → 以 Queues 轮询替代。
- 渠道 key 可选 AES-GCM（MASTER_KEY）加密；未配置时以原版换行分隔明文存储。

详见 [`test-report.md`](./test-report.md) §5 与 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 的 LIMITATION 清单。
