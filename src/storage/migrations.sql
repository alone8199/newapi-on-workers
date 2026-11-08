-- ============================================================
-- NewAPI-on-Workers D1 Schema
-- 字段语义与 NewAPI (One API 分支) 对齐；Workers 适配见 ARCHITECTURE.md §3
-- 时间戳统一 Unix 秒（与原版 util.GetTimestamp 一致）
-- ============================================================

-- 用户表（字段对齐 NewAPI model.User；列名与 GORM 迁移产物一致，"group" 为保留字需双引号引用）
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT NOT NULL UNIQUE,
  password          TEXT NOT NULL,            -- 哈希：bcrypt(cost=10)，不存明文
  display_name      TEXT NOT NULL DEFAULT '',
  role              INTEGER NOT NULL DEFAULT 1, -- 1=普通 10=管理员 100=超级管理员
  status            INTEGER NOT NULL DEFAULT 1, -- 1=启用 2=禁用
  email             TEXT NOT NULL DEFAULT '',
  github_id         TEXT NOT NULL DEFAULT '',
  discord_id       TEXT NOT NULL DEFAULT '',
  oidc_id           TEXT NOT NULL DEFAULT '',
  wechat_id         TEXT NOT NULL DEFAULT '',
  telegram_id       TEXT NOT NULL DEFAULT '',
  linux_do_id       TEXT NOT NULL DEFAULT '',
  quota             REAL NOT NULL DEFAULT 0,    -- 总额度
  used_quota        REAL NOT NULL DEFAULT 0,    -- 已用额度（权威，禁止仅存 KV）
  request_count     INTEGER NOT NULL DEFAULT 0,
  "group"           TEXT NOT NULL DEFAULT 'default', -- 分组（计费倍率）；对应原版 model.User.Group
  aff_code          TEXT NOT NULL DEFAULT '',
  aff_count         INTEGER NOT NULL DEFAULT 0,
  aff_quota         INTEGER NOT NULL DEFAULT 0,    -- 邀请剩余额度
  aff_history_quota INTEGER NOT NULL DEFAULT 0,    -- 邀请历史额度
  inviter_id        INTEGER NOT NULL DEFAULT 0,
  setting           TEXT NOT NULL DEFAULT '{}',   -- 用户设置 JSON（含 sidebar_modules）
  stripe_customer   TEXT NOT NULL DEFAULT '',
  remark            TEXT NOT NULL DEFAULT '',
  auth_version      INTEGER NOT NULL DEFAULT 1,   -- 登录会话鉴权版本
  last_login_at     INTEGER NOT NULL DEFAULT 0,
  created_time      INTEGER NOT NULL DEFAULT 0,
  deleted_time      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- 渠道表（列对齐原版 model.Channel；key 支持多 Key，JSON 数组；models 逗号分隔）
CREATE TABLE IF NOT EXISTS channels (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  type                  INTEGER NOT NULL DEFAULT 0, -- 渠道类型枚举（OpenAI/Azure/Bedrock/...）
  key                   TEXT NOT NULL DEFAULT '',    -- 多 Key JSON（启用 MASTER_KEY 时为 AES-GCM 密文）
  name                  TEXT NOT NULL DEFAULT '',
  openai_organization   TEXT NOT NULL DEFAULT '',
  base_url              TEXT NOT NULL DEFAULT '',
  other                 TEXT NOT NULL DEFAULT '',    -- 附加配置 JSON（如 Region/ApiVersion）
  models                TEXT NOT NULL DEFAULT '',    -- 逗号分隔模型列表
  "group"               TEXT NOT NULL DEFAULT 'default', -- 适用分组（对应原版 model.Channel.Group）
  status                INTEGER NOT NULL DEFAULT 1,   -- 1=启用 2=禁用 3=测试
  weight                INTEGER NOT NULL DEFAULT 0,   -- 权重（0=按优先级）
  test_model            TEXT NOT NULL DEFAULT '',
  created_time          INTEGER NOT NULL DEFAULT 0,
  test_time             INTEGER NOT NULL DEFAULT 0,
  response_time         INTEGER NOT NULL DEFAULT 0,
  balance               REAL NOT NULL DEFAULT 0,
  balance_updated_time  INTEGER NOT NULL DEFAULT 0,
  used_quota            REAL NOT NULL DEFAULT 0,
  model_mapping         TEXT NOT NULL DEFAULT '',
  status_code_mapping   TEXT NOT NULL DEFAULT '',
  priority              INTEGER NOT NULL DEFAULT 0,
  auto_ban              INTEGER NOT NULL DEFAULT 1,  -- 失败自动禁用
  other_info            TEXT NOT NULL DEFAULT '',
  tag                   TEXT NOT NULL DEFAULT '',
  setting               TEXT NOT NULL DEFAULT '',
  param_override        TEXT NOT NULL DEFAULT '',
  header_override       TEXT NOT NULL DEFAULT '',
  remark                TEXT NOT NULL DEFAULT '',
  channel_info          TEXT NOT NULL DEFAULT '{}',
  settings              TEXT NOT NULL DEFAULT '',
  retry_times           INTEGER NOT NULL DEFAULT 0,   -- Worker 故障切换（原版无，前端忽略）
  use_time              INTEGER NOT NULL DEFAULT 0,   -- Worker 统计
  auto_ban_log          TEXT NOT NULL DEFAULT '',
  disabled_by_failure   INTEGER NOT NULL DEFAULT 0    -- Worker 自动禁用标记
);
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);

-- 令牌表（sk- 前缀；remain_quota 余额落 D1）
CREATE TABLE IF NOT EXISTS tokens (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL DEFAULT 0,
  name            TEXT NOT NULL DEFAULT '',
  key             TEXT NOT NULL DEFAULT '',         -- 哈希后的 key（不存明文）
  key_hash        TEXT NOT NULL DEFAULT '',
  status          INTEGER NOT NULL DEFAULT 1,
  created_time    INTEGER NOT NULL DEFAULT 0,
  accessed_time   INTEGER NOT NULL DEFAULT 0,
  expired_time    INTEGER NOT NULL DEFAULT 0,
  remain_quota    REAL NOT NULL DEFAULT 0,
  unlimited_quota INTEGER NOT NULL DEFAULT 0,
  "group"         TEXT NOT NULL DEFAULT '',     -- 令牌分组（跨分组重试用）
  auto_groups     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tokens_key ON tokens(key_hash);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);

-- 日志表（高频写入，经 Queues 异步落盘）
CREATE TABLE IF NOT EXISTS logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL DEFAULT 0,
  channel_id       INTEGER NOT NULL DEFAULT 0,
  token_id         INTEGER NOT NULL DEFAULT 0,
  model            TEXT NOT NULL DEFAULT '',
  mode             TEXT NOT NULL DEFAULT '',
  type             INTEGER NOT NULL DEFAULT 0,
  content          TEXT NOT NULL DEFAULT '',
  quota            REAL NOT NULL DEFAULT 0,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens     INTEGER NOT NULL DEFAULT 0,
  ip               TEXT NOT NULL DEFAULT '',
  request_time     INTEGER NOT NULL DEFAULT 0,
  use_time         INTEGER NOT NULL DEFAULT 0,
  is_stream        INTEGER NOT NULL DEFAULT 0,
  success          INTEGER NOT NULL DEFAULT 1,
  request_detail   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_channel ON logs(channel_id);
CREATE INDEX IF NOT EXISTS idx_logs_request_time ON logs(request_time);

-- 兑换码
CREATE TABLE IF NOT EXISTS redemptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT NOT NULL DEFAULT '',
  key_hash      TEXT NOT NULL DEFAULT '',
  status        INTEGER NOT NULL DEFAULT 1,
  name          TEXT NOT NULL DEFAULT '',
  quota         REAL NOT NULL DEFAULT 0,
  created_time  INTEGER NOT NULL DEFAULT 0,
  redeemed_time INTEGER NOT NULL DEFAULT 0,
  user_id       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_redemptions_key ON redemptions(key_hash);

-- 分组（计费倍率）
CREATE TABLE IF NOT EXISTS groups (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL DEFAULT '',
  ratio  REAL NOT NULL DEFAULT 1,
  public INTEGER NOT NULL DEFAULT 1
);

-- 模型单价（默认倍率）
CREATE TABLE IF NOT EXISTS pricing (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  model             TEXT NOT NULL DEFAULT '',
  type              INTEGER NOT NULL DEFAULT 0,
  price             REAL NOT NULL DEFAULT 0,
  purchased_tokens  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(model)
);

-- 系统配置（同时缓存 KV）
CREATE TABLE IF NOT EXISTS options (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- 任务型端点状态机（Midjourney/Suno/视频）
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,        -- 内部 task id（uuid）
  type        TEXT NOT NULL DEFAULT '', -- mj / suno / video
  action      TEXT NOT NULL DEFAULT '', -- imagine / upscale / describe ...
  status      TEXT NOT NULL DEFAULT 'submitted', -- submitted/processing/success/fail/timeout
  user_id     INTEGER NOT NULL DEFAULT 0,
  token_id    INTEGER NOT NULL DEFAULT 0,
  channel_id  INTEGER NOT NULL DEFAULT 0,
  progress    INTEGER NOT NULL DEFAULT 0,
  properties  TEXT NOT NULL DEFAULT '{}',
  result      TEXT NOT NULL DEFAULT '{}',
  upstream_id TEXT NOT NULL DEFAULT '',
  callback    TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, type);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);

-- 登录会话（对应原版 user_sessions；D1 为权威，KV 可缓存）
CREATE TABLE IF NOT EXISTS user_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sid               TEXT NOT NULL UNIQUE,        -- 会话 ID
  user_id           INTEGER NOT NULL DEFAULT 0,
  auth_version      INTEGER NOT NULL DEFAULT 1,
  version           INTEGER NOT NULL DEFAULT 1,  -- 会话版本（令牌轮换用）
  refresh_token_hash TEXT NOT NULL DEFAULT '',   -- refresh token 哈希
  login_method      TEXT NOT NULL DEFAULT '',
  ip                TEXT NOT NULL DEFAULT '',
  user_agent        TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL DEFAULT 0,
  last_active_at    INTEGER NOT NULL DEFAULT 0,
  expires_at        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_refresh ON user_sessions(refresh_token_hash);

-- 初始化默认数据（管理员 root / 默认分组 / 默认倍率选项）
INSERT OR IGNORE INTO options (key, value) VALUES
  ('FileUploadPermission', '1'),
  ('DataExportPermission', '1'),
  ('DisplayInCurrencyEnabled', '0'),
  ('AutomaticDisableChannelEnabled', '1'),
  ('QuotaForNewUser', '500000'),
  ('ServerAddress', ''),
  ('SessionSecret', '');

INSERT OR IGNORE INTO groups (id, name, ratio, public) VALUES (1, 'default', 1, 1);
