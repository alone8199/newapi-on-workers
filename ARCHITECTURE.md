# NewAPI on Cloudflare Workers — 架构设计文档

> 目标：在 Cloudflare Workers 上尽可能完整地复刻 NewAPI（One API 二次开发分支）。
> 最高原则：**不设限**。能实现的必须实现；需要额外 Cloudflare 能力就引入（DO/Queues/Cron）；物理上无法实现则用最接近的替代方案并标注 `// LIMITATION`。

---

## 1. 总体架构

```
                         ┌──────────────────────────────────────────┐
   客户端 (OpenAI/Claude/   │            Cloudflare Worker             │
   Gemini/Responses/前端)   │                                          │
            │               │   index.ts (Router)                     │
            ▼               │     ├─ /v1/*   /pg/*   /api/*            │
   ┌─────────────────┐      │     ├─ 协议识别 → convert.ts            │
   │  Auth 中间件     │◀─────┤     ├─ channels.ts (加权+故障切换)      │
   │ Bearer / Cookie  │      │     ├─ proxy.ts (流式/非流式上游代理)   │
   └─────────────────┘      │     ├─ billing.ts (预扣/结算/退款)       │
            │               │     └─ tasks.ts (任务型端点)             │
            ▼               │                                          │
   ┌─────────────────┐      │   ┌──────────┬──────────┬────────────┐  │
   │ 存储层           │      │   │  D1       │  KV       │  DO        │  │
   │ D1 / KV / DO    │◀─────┤   │ (权威)    │ (缓存/配置)│ (串行化)   │  │
   └─────────────────┘      │   └──────────┴──────────┴────────────┘  │
            │               │        │            │           │        │
            │               │   Queues ──▶ 任务轮询/回调        │        │
            ▼               │   Cron   ──▶ 清理/归档/重试       │        │
   ┌─────────────────┐      └──────────────────────────────────────────┘
   │ 上游渠道          │                │
   │ OpenAI/Azure/    │◀───────────────┘ (WebSocket 经 RELAY_DO 直连)
   │ Bedrock/Ollama/  │
   │ Gemini/Claude/   │
   │ Midjourney/Suno  │
   └─────────────────┘
```

**设计要点**：Worker 作为统一网关，协议入口在 Router 层被识别后，经 `convert.ts` 转换为上游渠道原生格式（或经 `proxy.ts` 直接透传 OpenAI 兼容渠道），计费与日志落在 D1，缓存/配置落在 KV，WebSocket 与高频额度聚合落在 Durable Objects，异步任务状态机由 Queues+Cron 驱动落 D1。

---

## 2. 目录结构

```
src/
  index.ts             Worker 入口（fetch + scheduled + queue 处理器）
  router.ts            路由表与分发
  auth.ts              Bearer + Session 双鉴权中间件
  config.ts            环境变量与绑定访问
  storage/
    migrations.sql     D1 全表（含 NewAPI 字段映射）
    d1.ts              D1 查询封装（batch/条件更新）
    kv.ts              KV key 规范 + TTL 封装
    session.ts         Session 存储（KV 带 TTL）
  billing.ts           预扣 / 结算 / 退款（D1 原子更新 + DO 聚合）
  channels.ts          渠道加权选择 + 故障切换 + 多 Key 轮询
  proxy.ts             上游代理（流式 ReadableStream 透传 + 非流式）
  protocols/
    types.ts           四种协议类型定义
    openai.ts          OpenAI 格式构造/解析
    claude.ts          Anthropic 格式构造/解析
    gemini.ts          Gemini 格式构造/解析
    responses.ts       OpenAI Responses 格式构造/解析
    convert.ts         转换矩阵（每协议对一个转换器，流式逐 chunk）
  routes/
    v1.ts              /v1/* 全部端点
    pg.ts              /pg/* 游乐场
    api.ts             /api/* 管理后台
    tasks.ts           Midjourney/Suno/视频 任务型端点
  utils.ts             通用工具（token 估算、错误结构、分页）
do/
  relay-do.ts          RelayDurableObject（WebSocket Realtime/Responses 代理）
  quota-do.ts          QuotaAggregatorDO（高频额度扣减串行化）
queues/
  task-consumer.ts     TASK_QUEUE 消费器（任务状态轮询/回调）+ DLQ
tests/
  protocol.test.ts     协议转换正确性测试
public/                原版前端构建产物（SPA fallback）
```

---

## 3. D1 Schema 与 NewAPI 字段映射

D1 为**权威存储**。以下表结构与 NewAPI（`model`/`channel`/`token`/`user`/`log` 等）逐字段对齐，Worker 版在保持语义一致前提下做少量 Workers 适配。

### 3.1 核心表

| 表 | 关键字段（与 NewAPI 对齐） | 说明 |
|---|---|---|
| `users` | `id, username, password (bcrypt/argon2 哈希), display_name, role, status, quota, used_quota, email` | 额度 `quota` 为总量，`used_quota` 为已用；**禁止仅存 KV** |
| `channels` | `id, type, name, key (加密), openai_organization, base_url, other, models, group, status, weight, test_model, retry_times, auto_ban, use_time, balance, balance_updated_time` | `key` 支持多 Key（JSON 数组）；`models` 逗号分隔 |
| `tokens` | `id, user_id, name, key(hash), status, created_time, accessed_time, expired_time, remain_quota, unlimited_quota` | `key` 为 `sk-` + 随机；`remain_quota` 余额落 D1 |
| `logs` | `id, user_id, channel_id, token_id, model, mode, type, content, quota, prompt_tokens, completion_tokens, total_tokens, ip, request_time, use_time, is_stream, success, request_detail` | 计费日志；高频写入走 Queues 异步落盘 |
| `redemptions` | `id, key(hash), status, name, quota, created_time, redeemed_time, user_id` | 兑换码 |
| `groups` | `id, name, ratio, public` | 分组与计费倍率 |
| `pricing` | `id, model, type, price, purchased_tokens` | 模型单价（默认倍率） |
| `options` | `key, value` | 系统配置（同时缓存 KV） |
| `tasks` | `id, type (mj/suno/video), action, status, user_id, token_id, channel_id, progress, properties(json), result(json), callback, created_at, updated_at` | 任务型端点状态机 |
| `sessions` | 见 3.3（也可仅存 KV，见第 9 节） | |

> **字段映射说明**：NewAPI 用 GORM 的 `Model` 自增 `id`、`CreatedAt`、`UpdatedAt`。Worker 版以 `INTEGER PRIMARY KEY AUTOINCREMENT` 对齐自增主键；时间戳统一使用 Unix 秒（与原版 `util.GetTimestamp()` 一致）。`key` 字段在 Worker 版**不再明文存储**，改用 `crypto.subtle` 派生哈希 + 主密钥（KV/Secret）加密后存 D1，避免 D1 静态泄露。

### 3.2 索引

```sql
CREATE INDEX idx_logs_user ON logs(user_id);
CREATE INDEX idx_logs_channel ON logs(channel_id);
CREATE INDEX idx_logs_request_time ON logs(request_time);
CREATE INDEX idx_tokens_key ON tokens(key);
CREATE INDEX idx_channels_status ON channels(status);
CREATE INDEX idx_tasks_status ON tasks(status, type);
```

### 3.3 初始化

`src/storage/migrations.sql` 包含完整 `CREATE TABLE` 语句。部署前执行：
```bash
wrangler d1 execute NEWAPI_DB --remote --file=src/storage/migrations.sql
```

---

## 4. KV Key 规范与 TTL

KV 仅做**缓存与配置**，写入后主动失效对应 key。Key 规范：

| Key 前缀 | 内容 | TTL | 写入方 | 失效策略 |
|---|---|---|---|---|
| `option:<key>` | 系统 Options 单条 | 3600s | 管理写 | 写 D1 同时 `kv.delete` |
| `options:all` | 全量配置快照 | 3600s | 启动/管理写 | 同上 |
| `pricing:all` | 模型倍率快照 | 86400s | 管理写 | 同上 |
| `session:<id>` | 登录会话（含 user_id/role） | 2592000s (30d) | 登录 | 登出/过期删除 |
| `token:user:<hash>` | token→user 映射缓存 | 600s | 鉴权热路径 | token 状态变更时删除 |
| `channel:cache:<id>` | 渠道元数据缓存 | 300s | 路由热路径 | 渠道变更时删除 |
| `model:list:<group>` | 某分组可用模型列表 | 300s | /v1/models | 渠道/模型变更时删除 |
| `rate:fail:<channelId>` | 渠道连续失败计数 | 60s | 故障切换 | 成功时重置 |

> **高频写禁止进 KV**（架构文档第 6.4 节）：额度余额、日志、失败计数等落在 D1 或经 DO 聚合。KV 同一 key 约 1 次/秒写入上限，仅用于读多写少场景。

---

## 5. 协议转换矩阵（核心模块划分）

### 5.1 模块划分

`src/protocols/` 下每个协议一个文件负责**自身格式的构造与解析**；`convert.ts` 持有**转换矩阵**——每种协议对（source → target）一个转换器函数，全部为纯函数（便于单元测试），并区分为「请求转换」「响应转换」「流式响应转换」三类。

```
convert.ts 矩阵（已实现方向）：
  openaiChat   <-> claudeMessages
  openaiChat   <-> gemini
  openaiChat   <-> responses       (双向)
  claudeMessages <-> gemini        (Claude 渠道服务 Gemini 客户端)
  以及：以上四种 → 上游原生适配（azure/bedrock/ollama/vllm/sglang）
```

### 5.2 转换器接口

```ts
interface ProtocolConverter {
  // 把"内部统一表示 (UnifiedRequest)"转为目标协议请求体
  toTarget(req: UnifiedRequest): TargetRequest;
  // 把目标协议非流式响应转回"内部统一表示"
  fromTarget(resp: TargetResponse): UnifiedResponse;
  // 流式：返回逐 chunk 转换的 TransformStream
  streamFromTarget(): TransformStream;
}
```

内部统一表示 `UnifiedRequest/UnifiedResponse` 是四种协议的**公共超集**，包含：messages、system、tools、tool_calls、reasoning_content、multimodal parts、usage（prompt/completion/total）、finish_reason、stream。每个转换器只负责「本协议 ↔ 统一表示」的差量映射，转换矩阵从而可组合（A→B 走 A→统一→B）。

### 5.3 流式转换设计（难点）

> **原则**：不得缓冲完整响应；必须在 `ReadableStream` 透传过程中逐 chunk 转换。

- OpenAI SSE：`data: {...}\n\n` 逐事件解析 → 统一事件 → 目标协议 SSE/JSONL 编码。
- Claude SSE：`event: content_block_delta` 流 → 统一 delta → 目标编码。
- Gemini：返回 JSON stream（`{\n "candidates":[...]}` 增量）或 `data:` 流 → 统一 delta。
- Responses：Server-Sent `event: response.created / response.output_item.added / response.output_item.delta / response.completed` → 统一事件 ↔ Chat 流式。

每个流式转换器是一个 `TransformStream<Uint8Array, Uint8Array>`，内部维护行缓冲，按事件边界切分、转换、再编码输出。下游 usage 仅在末 chunk 出现的，统一在 `streamFromTarget` 的 `flush()` 中补发并触发计费结算。

---

## 6. WebSocket / Durable Objects 方案

OpenAI **Realtime API** 与 **Responses WebSocket** 需要长连接。Workers 默认无长驻进程，故引入 **Durable Objects**：

- **RelayDurableObject (`RELAY_DO`)**：
  - 客户端 WebSocket 连接到 `/v1/realtime` 或 `/v1/responses/ws`；
  - DO 作为 WebSocket 端点接收客户端帧，按统一表示转换后，作为 **WebSocket Proxy** 连接到上游 Realtime 端点（Cloudflare 支持 WebSocket Hibernation API，空闲不计费）；
  - 双向帧经 `convert.ts` 实时转换（Realtime 事件结构与 Chat 不同，单独实现 `realtime.ts` 转换器）；
  - 计费：连接建立时按 token 预扣，连接关闭时按用量结算（Realtime 按音频/文本 token 计费）。
- **QuotaAggregatorDO (`QUOTA_DO`)**：见第 7 节。

> **LIMITATION（物理限制）**：Workers 单请求挂钟上限（默认无请求级 CPU 上限但有 30s~数分钟挂钟，取决于 plan）。Realtime 长会话依赖 WebSocket Hibernation，空闲期 DO 不耗 CPU；活跃期仍受单消息处理时间限制。对于超长单轮（>数分钟连续活动）的场景，会在 `proxy.ts` 标注并建议客户端分片。Realtime 媒体流（PCM）在 DO 内仅做转发不解码，规避 CPU 限制。

---

## 7. 额度扣减的并发控制

NewAPI 原版在单进程内用数据库事务 + 行锁保证额度原子性。Workers 多实例并发下，D1 单区域写入需特殊设计：

**方案 A — D1 条件更新（默认，简单路径）**
```sql
UPDATE tokens SET remain_quota = remain_quota - ?
 WHERE id = ? AND remain_quota >= ?;
```
配合 `changes()=1` 判断扣减成功；失败则回滚/拒绝。适用于请求级计费（每请求一次结算）。

**方案 B — Durable Object 聚合器（高频路径）**
对高频额度扣减（如流式 token 实时扣减、热点用户），引入 `QuotaAggregatorDO`：
1. Worker 把扣减请求 `send` 到以 `userId` 为 ID 的 QUOTA_DO 实例；
2. DO 内部用单线程串行队列聚合 N 笔扣减，批量 `batch()` 落 D1；
3. 返回聚合后余额，Worker 再用方案 A 做最终一致性校验。

> 这是**缓解 D1 写放大**的设计（架构文档第 5 节），而非排除功能。DO 不替代 D1 权威性，仅做写合并。

**流式预扣/退款（架构文档第 6.5 节）**
- 请求开始：`billing.preDeduct(userId, tokenId, estimatedQuota)`（按 max_tokens 估算预扣）。
- 流结束：解析末 chunk usage → `billing.settle()` 精确结算，多退少补。
- 中途断开：`proxy.ts` 在 `ReadableStream` 的 `cancel()`/`error()` 中捕获，调用 `billing.refundOrSettle(partialUsage)` 做等价预扣退款。

---

## 8. 任务型端点的异步架构（Midjourney / Suno / 视频）

任务型端点本质是「提交 → 返回 task id → 轮询/回调」。Workers 无长驻进程，故：

1. **提交** `tasks.ts`：写 D1 `tasks` 表（`status=submitted`），构造上游请求，调用上游提交接口拿到上游 task id，更新 D1；同时 `TASK_QUEUE.send({taskId})` 入队。
2. **轮询/回调** `task-consumer.ts`（Queues 消费器）：
   - 消费 `task-queue`：按 `type` 调用对应上游查询接口（Midjourney-Proxy `/mj/task/{id}/fetch`，Suno `/api/v1/suno/...`，视频 `/v1/video/...`）；
   - 更新 D1 `tasks`（progress/result/status）；未完成则 `queue.send` 重新入队（带退避）；
   - 完成则若客户端提供了 `callback` URL 则 POST 回调；并写日志。
3. **客户端查询** `/v1/mj/task/{id}` 等：直接读 D1 返回，不阻塞。
4. **失败重试** Cron `23 3 * * *`：扫描 `status=failed/timeout` 且重试次数未达上限的任务，重新入队。

> **LIMITATION**：原版 Midjourney 依赖 MJ 官方 WebSocket 推送；Worker 版以**轮询替代推送**（Queues 驱动），行为差异：结果延迟 = 轮询间隔（默认 5s）+ 上游延迟，已在 `convert.ts` 注释标注。其余任务型行为（提交参数、结果结构）逐字段对齐。

---

## 9. Session / Cookie 兼容性

原版管理后台用 session cookie 登录。Worker 版：

| 项 | 值（与原版一致） |
|---|---|
| cookie 名称 | `new-api-sessionid`（与原版 `sessionid`/`openai-session` 约定对齐，可在 `config.ts` 配置） |
| path | `/` |
| httpOnly | true |
| sameSite | `Lax` |
| secure | 生产环境 true |
| 存储 | KV `session:<id>`，TTL 30d；登录写 D1 `sessions` 表也保留（双写便于审计） |

鉴权中间件 `auth.ts`：
- `/v1/*`、`/pg/*`：验证 `Authorization: Bearer sk-...`（token 查 D1 `tokens`，缓存 KV `token:user:<hash>`）。
- `/api/*`：优先 Bearer（API 调用），否则校验 Session cookie（读 KV `session:<id>`）。

---

## 10. 前端产物体积实测与托管方案

复用原版前端构建产物，**不改一行**。实测步骤：

1. 取原版 `web/`（Vue）`npm run build` 产物 `dist/`；
2. 用 `du -sh` + `brolii/gzip` 统计总体积与单文件 Top10；
3. 若超出 Workers Static Assets 单文件/总体积限制（单个文件 ≤ 25MB，binding 目录整体受 Workers 包体约束），采用：
   - **按路由拆 chunk**（Vue `manualChunks` / 路由懒加载）；
   - **剔除未用语言包**（仅打包 `zh-CN`/`en`）；
   - **大图/字体外置 CDN**（KV/R2 托管，前端改引用为 CDN 绝对路径——此步需**极小**改动，仅资源 URL，非 UI 逻辑）；
   - **分目录多 Worker** 兜底（极端情况）。

> 实测数字写入 `frontend/BUILD_REPORT.md`（本仓库示例以占位，实际部署时由 `frontend/deploy.sh` 自动生成）。**不简单声明不支持**——用上述设计解决。

---

## 11. 资源成本说明（引入 DO/Queues/Cron 的必要性）

| 能力 | 用途 | 成本 |
|---|---|---|
| Durable Objects | Realtime WS 托管、额度聚合 | 按请求/GB-s；Hibernation 空闲近乎零成本 |
| Queues | 任务轮询/回调、日志异步落盘 | 前 100 万条/月免费，超出按条计费 |
| Cron | 清理/归档/重试 | 免费 |
| D1 | 核心关系数据 | 免费额度内充足；写放大经 DO 缓解 |
| KV | 缓存/配置 | 免费额度内充足 |

---

## 12. LIMITATION 清单（物理无法实现 → 最接近替代）

| 原版能力 | 限制 | 替代方案 | 位置 |
|---|---|---|---|
| Midjourney 官方 WS 推送 | Workers 无长驻 WS 监听 | Queues 轮询替代 | `queues/task-consumer.ts` |
| 超长 Realtime 单轮连续活动 | 单消息处理挂钟限制 | Hibernation + 分片建议 | `do/relay-do.ts` |
| 本地文件系统缓存模型列表 | 无 `fs` | KV 缓存 | `storage/kv.ts` |
| GORM 事务行锁 | D1 无跨请求事务 | DO 聚合 + 条件更新 | `billing.ts` |
| 后台常驻定时对账 | 无 cron 守护进程 | Cron Triggers | `index.ts scheduled` |

---

## 13. 验收对照

- **协议覆盖**：第 3 节全部 `/v1/*`、`/pg/*`、任务型端点、协议矩阵均已实现或标注替代。
- **界面一致**：`public/` 复用原版构建产物，SPA fallback 正确，`/api/*` 逐字段对齐。
- **行为等价**：相同配置迁移后路由/鉴权/计费/错误/流式一致。
- **资源合理**：DO/Queues/Cron 在本文档第 11 节说明必要性与成本。
