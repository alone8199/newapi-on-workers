# 基准环境搭建 + 契约差异分析（第 1 步交付物 · 草案）

> 本文件对应收尾任务的「第 1 步」：**先建立原版黄金基准 + seed.sql 草案 + 契约差异分析**，确认后再动 Worker 代码。
> 所有契约结论均来自**直接阅读原版源码**（`QuantumNous/new-api` main 分支），非凭记忆。

---

## 0. 已取得的真实契约（来自源码，已落盘 `/root/new-api-src`）

| 文件 | 关键结论 |
|---|---|
| `common/gin.go` | 管理 API 响应信封 = `{success, message, data}`；**错误也返回 HTTP 200**（`ApiError`/`ApiErrorMsg` 用 `http.StatusOK`）。`ApiSuccess` 的 `message` 为空串 `""`。 |
| `controller/channel.go` | 渠道列表 `data` 信封 = `{items, total, page, page_size, type_counts}`；列表项经 `clearChannelInfo` **剥离 `key` 字段**。默认 `page_size=20`。 |
| `model/*.go` | 真实表结构/列名（见 `seed.sql`）。`users.group`、`channels.group`、`tokens.group`、`logs.channel`(列名 channel_id) 等为保留字/特殊列名。 |
| `common/crypto.go` | 密码 = **bcrypt(cost=10)**；`ValidatePasswordAndHash` 同时兼容 `$argon2id$` 前缀。共用 seed 必须原版与 Worker 都能验证 → Worker 必须实现 bcrypt 校验。 |
| `constant/channel.go` | 渠道 Type：OpenAI=1, Azure=3, Anthropic=14, Gemini=24, AWS=33, SunoAPI=36, AdvancedCustom=58。 |
| `controller/auth_session.go` | 会话采用 **refresh-token + session bundle** 模式（非简单 `session:<id>`）。登录写 `RefreshCookieName` Cookie 并下发 `{session, refresh_token}`。Cookie 名称/属性需在实现阶段精确对齐。 |
| `controller/relay.go` | `/v1/*` 走标准 OpenAI 错误对象 `{error:{message,type,param,code}}` + 对应 HTTP 状态码（400/401/403/429/500…）；错误经由 `types.NewOpenAIError`。 |

---

## 1. 基准环境搭建步骤（原版黄金基准）

> 目标：在本地跑起一份原版 NewAPI（SQLite 模式即可），灌入 `seed.sql`，作为 diff 的 ORIGIN。

### 1.1 拉源码 + 构建运行（SQLite 模式，最省事）
```bash
git clone https://github.com/QuantumNous/new-api.git
cd new-api
# 用 SQLite（零依赖）。也可改 config 用 MySQL。
cp .env.example .env        # 设置 SQLITE=true / 或 DATABASE_URL 指向 sqlite 文件
go mod download
go build -o new-api .
./new-api                  # 首次启动自动 GORM 迁移建表 + 创建初始 root（看终端提示的初始密码）
```

### 1.2 灌入共用基准数据
```bash
# 待原版建表后，将 seed.sql 应用到同一 SQLite 库
sqlite3 new-api.db < seed.sql
# 注意：seed.sql 中已含初始 root/admin/普通用户，若原版已自建 root，先清表再灌，
#       或仅灌 channels/tokens/options/redemptions/logs，users 用原版初始账号。
```

### 1.3 前端构建产物（界面一致性基准）
```bash
cd web
npm install
npm run build             # 产物在 web/dist
# 原版基准：把 web/dist 作为静态服务根（或 nginx 指向）
# Worker 版：wrangler.toml 的 assets.directory 指向**同一份** web/dist，不 patch
```

### 1.4 启动两端，准备 diff
```bash
# 原版
./new-api                  # 假设监听 :3000
# Worker（本地，模拟 KV/D1/DO/Queues）
cd worker-project
wrangler dev --local --persist-to .wrangler/state   # 假设监听 :8787
# 初始化本地 D1 后灌 seed
wrangler d1 execute newapi_db --local --file=./seed.sql
```

---

## 2. 已发现的契约差异（Worker 现状 vs 原版真实契约）—— 实现阶段必须修

> 以下均为**已实现源码与原版源码对比**得出的差异，按优先级排序。实现阶段会逐条修复并复测。

### 🔴 P0（会导致原版前端直接不可用）
1. **管理 API 错误状态码**：原版 `/api/*` 错误返回 **HTTP 200** + `{success:false,...}`；当前 Worker 可能对鉴权失败等返回 4xx。前端只认 `res.success`，4xx 会直接抛网络错误 → 必须全部改为 200 + 信封。
2. **密码算法**：原版 bcrypt(cost=10)；当前 Worker 用 PBKDF2/AES 是 **LIMITATION 误判**。共用 seed 要求两边都能验证 → Worker 必须实现 bcrypt 校验（纯 JS `bcryptjs`，Workers 可用）。
3. **渠道列表信封**：原版 `data={items,total,page,page_size,type_counts}` 且**列表项剥离 `key`**；当前 Worker 返回结构需对齐（含 `type_counts`，且 list 不返回 key）。

### 🟠 P1（字段/分页/语义差异）
4. **分页参数**：默认 `page_size=20`，字段名 `page`/`page_size`/`total`/`items`（不是 `data` 数组直接返回）。
5. **`success` 字段语义**：成功时 `message` 为 `""`（空串，非 null/省略）。
6. **`group` 列名**：D1 中 `group` 必须双引号引用（保留字）；`logs.channel` 列名实际为 `channel_id`（gorm 默认）。`migrations.sql` 需对齐。
7. **会话/Cookie**：原版为 refresh-token + session bundle；Worker 当前为简单 session cookie。需对齐 **Cookie 名称、path、httpOnly、SameSite、有效期**，否则登录态/前端检测异常。
8. **`/v1/*` 错误对象**：需严格 `{error:{message,type,param,code}}` + 正确 HTTP 状态码（当前实现需校验 param/code 字段是否齐备）。

### 🟡 P2（一致性增强）
9. **`X-Oneapi-Request-Id` / `X-Request-Id` Header**：原版在响应中回带请求 ID，前端/日志关联依赖；需确认并补齐。
10. **Option 键集合**：前端依赖的 option key（如 `RegisterEnabled`、`Language`、`Footer` 等）需与原版一致，否则设置页渲染缺失。
11. **`clearChannelInfo` 行为**：除 key 外，原版还清空 `Other`/`Setting` 等敏感字段中的密钥部分；需对齐脱敏范围。

---

## 3. 测试方案（与第 1 步配套）

### 3.1 契约 diff 工具 `compare-api.ts`
- 对**同一请求**分别打 ORIGIN（原版 :3000）与 WORKER（:8787），结构化 diff。
- 归一化：忽略 `id`/`created`/`created_at`/耗时/`system_fingerprint`/`request_id`；无序集合（如 `/v1/models` 的 `data`）排序后比；有序集合（logs）保序。
- 用例覆盖第 3 节全部端点（chat 流式/非流式、models、embeddings、images、audio、rerank、moderations、responses、messages、Gemini、/pg、Midjourney/Suno/视频、全部 `/api/*`）。

### 3.2 分层测试
| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元 | vitest | 协议转换器、计费公式、加权选择、bcrypt 校验、额度条件更新 |
| 集成 | vitest + miniflare/`unstable_dev` | 每端点对**本地 mock 上游**跑通，校验 D1 副作用（额度/logs） |
| 契约 | `compare-api.ts`（打本地原版） | 全端点逐字段 diff |
| E2E | Playwright | 第 3 节全部界面路径 + 截图对比 |

### 3.3 沙箱限制（需你本地完成的环节）
- ⚠️ **本沙箱无法运行原版 Go 二进制 / 构建 Vue 前端 / 跑 Playwright 带浏览器截图**。因此：
  - ORIGIN 实跑对比、界面像素级对比、前端零 console 错误验收，**需你在本地按 §1 启动原版后跑 `compare-api.ts` 与 Playwright**。
  - 我会在沙箱内用 **mock 上游 + miniflare** 验证 Worker 自身行为符合提取出的契约（信封/字段/状态码），并把每条差异的「原版预期」写进测试断言。
- 我提供的 `compare-api.ts` 默认 `ORIGIN`/`WORKER` 两个 base URL 可配置，你本地一键重跑即可。

---

## 4. 待你确认的事项

1. 基准环境是否按 §1（SQLite 模式 + 原版初始 root 后**仅灌渠道/令牌/选项/兑换/日志**，users 用原版初始账号）执行？还是希望我把 users 也纳入 seed（先清表再灌）？
2. seed.sql 中的**测试账号/密码/额度/渠道 key** 是否合适（目前是占位 key，真实联调需你替换为可用上游 key）？
3. 前端构建产物（`web/dist`）由你本地构建后放入 `public/`（或改 `wrangler.toml` 的 assets 指向），确认路径约定？
4. 对 §2 的 P0/P1 差异修复优先级是否认可？尤其是「管理 API 一律 HTTP 200 + 信封」「bcrypt 替代 PBKDF2」这两条，会改动 `auth.ts`/`api.ts`/`utils.ts`/D1 schema。

**确认后我将进入代码对齐阶段**：先改 P0（响应信封 + bcrypt + 渠道列表信封 + D1 schema 列名对齐），再补 P1/P2，最后产出 `compare-api.ts` 与 `test-report.md`。
