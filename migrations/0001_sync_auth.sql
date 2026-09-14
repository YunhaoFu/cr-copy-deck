-- cr-copy-deck 账号 + 云同步：D1 初始结构
-- 执行：npx wrangler d1 execute cr-copy-deck-sync --remote --file=migrations/0001_sync_auth.sql
-- 约定：所有时间戳统一用 epoch 毫秒（INTEGER），避免时区/字符串比较问题。

-- 用户：只用「用户名 + 密码」，不收集邮箱等任何个人信息。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY,            -- 服务端随机 id（16 位 base36）
  username      TEXT    NOT NULL,               -- 原样保存（用于展示）
  username_lc   TEXT    NOT NULL UNIQUE,        -- NFKC + 小写，用于唯一性与登录查找
  pw_scheme     TEXT    NOT NULL,               -- 'pbkdf2' 无 pepper / 'pbkdf2p' 有 pepper
  pw_iter       INTEGER NOT NULL,               -- PBKDF2 迭代次数（存库，将来可升级）
  pw_salt       TEXT    NOT NULL,               -- hex，16 字节
  pw_hash       TEXT    NOT NULL,               -- hex，32 字节派生密钥
  rc_hash       TEXT,                           -- 恢复码的 sha256（hex），忘记密码用
  data_rev      INTEGER NOT NULL DEFAULT 0,     -- 每次写入 +1，客户端据此判断是否冲突
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 会话：只存 sha256(token + pepper)，库被拖走也无法直接冒用登录态。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

-- 卡组：一行一套。deleted_at 非空即为墓碑（保留 90 天，用于跨设备同步删除）。
CREATE TABLE IF NOT EXISTS decks (
  user_id    TEXT    NOT NULL,
  deck_id    TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  cards      TEXT    NOT NULL,                 -- JSON：[{id,v} × 8]
  tower      INTEGER NOT NULL,
  sort_idx   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, deck_id)
);
CREATE INDEX IF NOT EXISTS idx_decks_user ON decks(user_id, deleted_at);

-- 每用户一行设置 + 主题（分别带时间戳，各自 LWW，互不覆盖）。
CREATE TABLE IF NOT EXISTS user_settings (
  user_id     TEXT    PRIMARY KEY,
  settings    TEXT    NOT NULL,                -- JSON
  settings_at INTEGER NOT NULL,
  theme       TEXT    NOT NULL,
  theme_at    INTEGER NOT NULL
);

-- 限流桶：注册/登录按 IP 与用户名计数（D1 没有原子限流原语，自己实现）。
CREATE TABLE IF NOT EXISTS auth_limits (
  bucket    TEXT    PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 0,
  window_at INTEGER NOT NULL
);
