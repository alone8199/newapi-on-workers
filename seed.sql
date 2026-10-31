-- ============================================================================
-- seed.sql  —— NewAPI on Workers 共用基准数据（草案 v1）
-- 设计原则：
--   1. 同一份文件同时灌入「原版 NewAPI（SQLite/MySQL）」与「Worker 版（D1）」，
--      因此所有 id / 时间戳 / 额度起点均固定写死，保证两端 diff 有意义。
--   2. 表结构与列名严格对齐原版 GORM 自动迁移产物（snake_case；保留字 group 用双引号）。
--   3. 密码使用 bcrypt(cost=10) 哈希，原版与 Worker 均用同一算法校验，登录可两边通过。
--   4. SQLite / D1 双兼容（不使用 MySQL 专有语法）。
--
-- 应用方式：
--   原版：  将本文件在初始化 DB 后执行（或合并进初始迁移）。
--   Worker： wrangler d1 execute newapi_db --local --file=./seed.sql
--           （远端用 --remote，仅首次初始化用，之后用迁移增量维护）
-- ============================================================================

-- ---------- users ----------
-- Role: 1=admin(root 也是 1 但 id=1), 普通用户 role 默认 1？原版：root role=1(超级)，普通 role=1 实际是普通。
-- 注：NewAPI 中 role: 1=普通用户, 10=管理员, 100=超级管理员(root)。这里按此语义。
INSERT INTO users
  (id, username, password, display_name, role, status, email, quota, used_quota, request_count, "group", created_at, last_login_at, auth_version)
VALUES
  (1, 'root',  '$2b$10$KaBSjumvtXNh5yCslU/hqeUdnqvOVk5Dxo8wKJOBqArLQyuQMdk/.', 'Root',     100, 1, 'root@example.com',    5000000, 0,    0, 'default', 1700000000, 1700000000, 1),
  (2, 'admin', '$2b$10$CjSBV3UnkQsBfSDp28z0XugCaGtuxVuCZbj9NwlBupEXDJJZuhEre', 'Admin',    10,  1, 'admin@example.com',   2000000, 0,    0, 'default', 1700000100, 1700000100, 1),
  (3, 'user1', '$2b$10$jHE6pdmqLXlLrAvzvOH01uto9c8y.HZLOTDipHUZlvHFaZLysp1Wa', 'User One',  1,  1, 'user1@example.com',    100000,  0,    0, 'default', 1700000200, 1700000200, 1),
  (4, 'user2', '$2b$10$tUR2s.1mo5Dqj9f9YlZ6.OyTXmokus4.6gbdJqFIe5q1RyrFa.t9u', 'User Two',  1,  1, 'user2@example.com',     50000,  0,    0, 'vip',     1700000300, 1700000300, 1),
  (5, 'user3', '$2b$10$gMVxcJgDmz5RfQNzphWQY.B5gzD4YhpWW2ssJNkrs7Xla5sc.kTDO', 'User Three',1,  1, 'user3@example.com',     10000,  0,    0, 'default', 1700000400, 1700000400, 1);

-- ---------- channels ----------
-- Type 常量：OpenAI=1, Azure=3, Anthropic=14, Gemini=24, AWS=33, SunoAPI=36
-- 故意失效渠道：id=5 指向不可达 base_url + 错误 key，用于故障切换/全失败用例。
INSERT INTO channels
  (id, type, key, name, status, weight, created_time, models, "group", used_quota, auto_ban, other)
VALUES
  (1, 1,  'sk-openai-seed-0001',     'OpenAI-Seed',      1, 10, 1700000000, 'gpt-4o-mini,gpt-4o,text-embedding-3-small', 'default', 0, 1, '{}'),
  (2, 14, 'sk-ant-seed-0002',        'Claude-Seed',      1, 5,  1700000050, 'claude-3-5-sonnet,claude-3-haiku',          'default', 0, 1, '{}'),
  (3, 24, 'gem-seed-0003',           'Gemini-Seed',      1, 5,  1700000100, 'gemini-1.5-pro,gemini-1.5-flash',           'default', 0, 1, '{}'),
  (4, 3,  'azure-seed-0004',         'Azure-Seed',       1, 8,  1700000150, 'gpt-4o-mini',                                'default', 0, 1, '{"ApiVersion":"2024-02-15-preview","ResourceName":"seed"}'),
  (5, 1,  'sk-broken-seed-0005',     'Broken-Seed',      1, 1,  1700000200, 'gpt-4o-mini',                                'default', 0, 1, '{}');
-- 失效渠道的 base_url 指向不可达地址（Worker 与原版均会因连接失败触发故障切换）
UPDATE channels SET base_url = 'http://127.0.0.1:9/unreachable' WHERE id = 5;

-- ---------- tokens ----------
-- 三个令牌：无限额度 / 低额度 / 带模型白名单
INSERT INTO tokens
  (id, user_id, key, status, name, created_time, expired_time, remain_quota, unlimited_quota, model_limits_enabled, model_limits, "group", used_quota, allow_user_quota_query)
VALUES
  (1, 3, 'sk-worker-seed-token-unlimited', 1, 'Unlimited-Token', 1700001000, -1, 0,     1, 0, '',        'default', 0, 1),
  (2, 4, 'sk-worker-seed-token-low',      1, 'Low-Token',      1700001100, -1, 100,    0, 0, '',        'vip',     0, 1),
  (3, 3, 'sk-worker-seed-token-whitelist',1, 'Whitelist-Token',1700001200, -1, 100000, 0, 1, 'gpt-4o-mini,claude-3-haiku', 'default', 0, 0);

-- ---------- options ----------
-- 仅放前端/后端依赖度高的关键项；完整项以原版默认值兜底。
INSERT INTO options (key, value) VALUES
  ('ServerAddress',         'http://localhost:3000'),
  ('RegisterEnabled',       'true'),
  ('EmailVerification',     'false'),
  ('PasswordLoginEnabled',  'true'),
  ('GitHubOAuthEnabled',    'false'),
  ('WeChatAuthEnabled',     'false'),
  ('TurnstileCheck',        'false'),
  ('RegisterDiscount',      '0'),
  ('Discount',              '1'),
  ('DefaultModelRatio',     '1'),
  ('DefaultGroupRatio',     '1'),
  ('QuotaForNewUser',       '0'),
  ('ChannelDisableThreshold','0'),
  ('AutomaticDisableChannel','false'),
  ('LogConsumeStatus',      '1'),
  ('DisplayInCurrency',     'false'),
  ('Language',              'zh'),
  ('Footer',                ''),
  ('EmailDomainWhitelist',  ''),
  ('Theme',                 'default');

-- ---------- redemptions ----------
INSERT INTO redemptions
  (id, user_id, key, status, name, quota, created_time, redeemed_time, used_user_id, expired_time)
VALUES
  (1, 1, 'SEEDREDEMPTIONCODE0000000000000001', 1, 'Seed-Code-100', 100000, 1700002000, 0, 0, 0);

-- ---------- logs（预置 2 条，便于列表/聚合用例） ----------
INSERT INTO logs
  (id, user_id, created_at, type, content, username, token_name, model_name, quota, prompt_tokens, completion_tokens, use_time, is_stream, channel, channel_name, token_id, "group", ip, request_id)
VALUES
  (1, 3, 1700003000, 1, '', 'user1', 'Unlimited-Token', 'gpt-4o-mini', 15, 10, 5, 800, 1, 1, 'OpenAI-Seed', 1, 'default', '127.0.0.1', 'seed-req-0001'),
  (2, 4, 1700003100, 1, '', 'user2', 'Low-Token',      'gpt-4o-mini', 15, 12, 3, 650, 0, 1, 'OpenAI-Seed', 2, 'vip',      '127.0.0.1', 'seed-req-0002');
