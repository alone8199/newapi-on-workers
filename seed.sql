-- ============================================================================
-- seed.sql  —— NewAPI on Workers 共用基准数据
-- 设计原则：
--   1. 同一份文件灌入「原版 NewAPI」与「Worker 版(D1)」，id/额度起点固定写死，diff 有意义。
--   2. 列名严格对齐本仓库 src/storage/migrations.sql 与原版 GORM 产物（保留字 "group" 用双引号引用）。
--   3. 密码 = bcrypt(cost=10)；token/redemption 的 key_hash = SHA-256(明文)（与本仓库 hashKey 一致）。
--   4. 渠道 key 与原版一致，为换行分隔纯文本（单 key 即纯字符串）；多 key 用 char(10) 分隔。
--   5. 注：原版一侧 token/兑换码 key_hash 使用原版自身算法；若用同一 seed 灌原版，
--      需在原版侧按原算法重算 key_hash（或让原版首次启动重建），属第 2 步本地对齐事项。
-- ============================================================================

-- ---------- users ----------
INSERT INTO users
  (id, username, password, display_name, role, status, email,
   github_id, discord_id, oidc_id, wechat_id, telegram_id, linux_do_id,
   quota, used_quota, request_count, "group",
   aff_code, aff_count, aff_quota, aff_history_quota, inviter_id,
   setting, stripe_customer, remark, auth_version, last_login_at, created_time, deleted_time)
VALUES
  (1, 'root',  '$2b$10$KaBSjumvtXNh5yCslU/hqeUdnqvOVk5Dxo8wKJOBqArLQyuQMdk/.', 'Root',     100, 1, 'root@example.com',
   '', '', '', '', '', '', 5000000, 0, 0, 'default', '', 0, 0, 0, 0, '{}', '', '', 1, 1700000000, 1700000000, 0),
  (2, 'admin', '$2b$10$CjSBV3UnkQsBfSDp28z0XugCaGtuxVuCZbj9NwlBupEXDJJZuhEre', 'Admin',    10,  1, 'admin@example.com',
   '', '', '', '', '', '', 2000000, 0, 0, 'default', '', 0, 0, 0, 0, '{}', '', '', 1, 1700000100, 1700000100, 0),
  (3, 'user1', '$2b$10$jHE6pdmqLXlLrAvzvOH01uto9c8y.HZLOTDipHUZlvHFaZLysp1Wa', 'User One',  1,  1, 'user1@example.com',
   '', '', '', '', '', '', 100000,  0, 0, 'default', '', 0, 0, 0, 0, '{}', '', '', 1, 1700000200, 1700000200, 0),
  (4, 'user2', '$2b$10$tUR2s.1mo5Dqj9f9YlZ6.OyTXmokus4.6gbdJqFIe5q1RyrFa.t9u', 'User Two',  1,  1, 'user2@example.com',
   '', '', '', '', '', '',  50000,  0, 0, 'vip',      '', 0, 0, 0, 0, '{}', '', '', 1, 1700000300, 1700000300, 0),
  (5, 'user3', '$2b$10$gMVxcJgDmz5RfQNzphWQY.B5gzD4YhpWW2ssJNkrs7Xla5sc.kTDO', 'User Three',1,  1, 'user3@example.com',
   '', '', '', '', '', '',  10000,  0, 0, 'default', '', 0, 0, 0, 0, '{}', '', '', 1, 1700000400, 1700000400, 0);

-- ---------- channels ----------
-- Type 常量：OpenAI=1, Azure=3, Anthropic=14, Gemini=24, AWS=33, SunoAPI=36
-- 故意失效渠道：id=5 指向不可达 base_url + 错误 key，用于故障切换/全失败用例。
INSERT INTO channels
  (id, type, key, name, status, weight, created_time, models, "group", used_quota, auto_ban, other, base_url)
VALUES
  (1, 1,  'sk-openai-seed-0001',     'OpenAI-Seed', 1, 10, 1700000000, 'gpt-4o-mini,gpt-4o,text-embedding-3-small', 'default', 0, 1, '{}', 'https://api.openai.com/v1'),
  (2, 14, 'sk-ant-seed-0002',        'Claude-Seed', 1, 5,  1700000050, 'claude-3-5-sonnet,claude-3-haiku',          'default', 0, 1, '{}', 'https://api.anthropic.com/v1'),
  (3, 24, 'gem-seed-0003',           'Gemini-Seed', 1, 5,  1700000100, 'gemini-1.5-pro,gemini-1.5-flash',           'default', 0, 1, '{}', 'https://generativelanguage.googleapis.com'),
  (4, 3,  'azure-seed-0004',         'Azure-Seed',  1, 8,  1700000150, 'gpt-4o-mini',                                'default', 0, 1, '{"ApiVersion":"2024-02-15-preview","ResourceName":"seed"}', 'https://seed.openai.azure.com'),
  (5, 1,  'sk-broken-seed-0005',     'Broken-Seed', 1, 1,  1700000200, 'gpt-4o-mini',                                'default', 0, 1, '{}', 'http://127.0.0.1:9/unreachable');

-- ---------- tokens ----------
-- 三个令牌：无限额度 / 低额度 / 带模型白名单
-- key_hash = SHA-256(明文 key)，与本仓库 hashKey 一致，Worker 端令牌鉴权可直接通过。
INSERT INTO tokens
  (id, user_id, key, key_hash, status, name, created_time, expired_time, remain_quota, unlimited_quota, "group", auto_groups)
VALUES
  (1, 3, 'sk-worker-seed-token-unlimited', '04c5820becb29eb8de3e72d097bd992e6252d1388b6f170e246f9d8a3fbae904', 1, 'Unlimited-Token', 1700001000, -1, 0,     1, 'default', ''),
  (2, 4, 'sk-worker-seed-token-low',       '1943d08c68f0b1fa34003158fa7e20b1c2b8fc63b1e6f7869c25814956eef33f', 1, 'Low-Token',       1700001100, -1, 100,   0, 'vip',      ''),
  (3, 3, 'sk-worker-seed-token-whitelist', '1fa19f24f7c87a9e57f5ad8e90d16ba2b97e93b26b04cb4f95c1492009f168ec', 1, 'Whitelist-Token', 1700001200, -1, 100000, 0, 'default', '');

-- ---------- options ----------
INSERT OR REPLACE INTO options (key, value) VALUES
  ('ServerAddress',         'http://localhost:3000'),
  ('RegisterEnabled',       'true'),
  ('PasswordLoginEnabled',  'true'),
  ('QuotaForNewUser',       '0'),
  ('Language',              'zh'),
  ('Footer',                ''),
  ('DisplayInCurrency',     'false'),
  ('FileUploadPermission',  '1'),
  ('DataExportPermission',  '1'),
  ('AutomaticDisableChannelEnabled', '1');

-- ---------- redemptions ----------
-- key_hash = SHA-256(明文 key)
INSERT INTO redemptions
  (id, user_id, key, key_hash, status, name, quota, created_time, redeemed_time)
VALUES
  (1, 0, 'SEEDREDEMPTIONCODE0000000000000001', '8a90b99f2ce5df27bb15da080ea2e5fe641d8ddf55e8b495998bd9539d328f21', 1, 'Seed-Code-100', 100000, 1700002000, 0);

-- ---------- logs（预置 2 条，便于列表/聚合用例） ----------
INSERT INTO logs
  (id, user_id, token_id, channel_id, model, mode, type, content, quota, prompt_tokens, completion_tokens, total_tokens, ip, request_time, use_time, is_stream, success, request_detail)
VALUES
  (1, 3, 1, 1, 'gpt-4o-mini', 'chat', 1, '', 15, 10, 5, 15, '127.0.0.1', 1700003000, 800, 1, 1, ''),
  (2, 4, 2, 1, 'gpt-4o-mini', 'chat', 1, '', 15, 12, 3, 15, '127.0.0.1', 1700003100, 650, 0, 1, '');
