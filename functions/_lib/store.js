/**
 * cr-copy-deck 云同步后端 · 共用工具（零依赖，Cloudflare Pages Functions）
 *
 * 设计前提：
 * - 运行在 Workers 免费版沙箱里，单请求 CPU 上限 10ms（超了直接 Error 1102，catch 不到），
 *   所以密码哈希用 PBKDF2 且迭代次数可配置、默认保守（见 iterationsOf）。
 * - 全部 SQL 走 prepared statement 绑定参数，不拼字符串。
 * - 只存「用户名 + 密码哈希」，不收集邮箱、IP 只存哈希用于限流。
 */

const enc = new TextEncoder();

export const SESSION_COOKIE = "crsess";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;   // 滑动 30 天
export const SESSION_MAX_MS = 90 * 24 * 3600 * 1000;   // 硬上限 90 天
export const MAX_DECKS = 300;
export const MAX_BODY = 256 * 1024;                    // 整包 256 KB
export const MAX_SETTINGS_LEN = 8 * 1024;              // 设置 JSON ≤ 8 KB
export const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000; // 墓碑保留 90 天

/* ---------------- 响应 ---------------- */

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/** D1 未绑定时的统一降级：前端据此切回纯本地模式，页面功能不受影响。 */
export function notConfigured() {
  return json({ ok: false, error: "storage_not_configured" }, 503);
}

export function fail(error, status = 400) {
  return json({ ok: false, error }, status);
}

/* ---------------- 编码 / 哈希 ---------------- */

export function bufToHex(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex) {
  const s = String(hex || "");
  if (s.length % 2) return new Uint8Array(0);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16) || 0;
  return out;
}

export async function sha256hex(text) {
  return bufToHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export async function hmacSha256Hex(keyText, msgText) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return bufToHex(await crypto.subtle.sign("HMAC", key, enc.encode(msgText)));
}

async function pbkdf2Hex(passwordBytes, saltBytes, iterations) {
  const key = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" }, key, 256
  );
  return bufToHex(bits);
}

/** 定长比较，避免按字符提前返回带来的时间侧信道。 */
export function ctEqual(a, b) {
  const x = String(a == null ? "" : a);
  const y = String(b == null ? "" : b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

/* ---------------- 随机 ---------------- */

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const RC_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // 去掉 0O1IL 等易混字符

export function randomId(len = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (let i = 0; i < len; i++) s += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return s;
}

export function randomToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)));   // 64 hex
}

/** 恢复码：12 位、4 位一组，注册时展示一次。 */
export function randomRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) s += "-";
    s += RC_ALPHABET[bytes[i] % RC_ALPHABET.length];
  }
  return s;
}

export function normRecoveryCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/* ---------------- 密码 ---------------- */

/**
 * PBKDF2 迭代次数。免费版 CPU 上限 10ms，实测 5 万次已逼近上限，
 * 这里默认 30000（配合 PASSWORD_PEPPER 强度足够）。
 * 升级到 Workers Paid 后可设 PBKDF2_ITERATIONS=210000。
 */
export function iterationsOf(env) {
  const n = Number(env && env.PBKDF2_ITERATIONS);
  return Number.isInteger(n) && n >= 1000 && n <= 1000000 ? n : 30000;
}

export async function hashPassword(env, password) {
  const pepper = String((env && env.PASSWORD_PEPPER) || "");
  const payload = pepper ? enc.encode(await hmacSha256Hex(pepper, password)) : enc.encode(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iter = iterationsOf(env);
  return {
    scheme: pepper ? "pbkdf2p" : "pbkdf2",
    iter,
    salt: bufToHex(salt),
    hash: await pbkdf2Hex(payload, salt, iter),
  };
}

const HEX64 = /^[a-f0-9]{64}$/;

export async function verifyPassword(env, password, user) {
  const scheme = String(user.pw_scheme || "");
  if ((scheme !== "pbkdf2" && scheme !== "pbkdf2p") || !HEX64.test(String(user.pw_hash || ""))) return false;
  const iter = Number(user.pw_iter);
  if (!Number.isInteger(iter) || iter < 1 || iter > 1000000) return false;
  const pepper = scheme === "pbkdf2p" ? String((env && env.PASSWORD_PEPPER) || "") : "";
  if (scheme === "pbkdf2p" && !pepper) return false;   // pepper 丢了就无法校验，明确失败
  const payload = pepper ? enc.encode(await hmacSha256Hex(pepper, password)) : enc.encode(password);
  const got = await pbkdf2Hex(payload, hexToBytes(user.pw_salt), iter);
  return ctEqual(got, String(user.pw_hash).toLowerCase());
}

/** 迭代次数或 scheme 变化时，登录成功后顺手升级哈希。 */
export function passwordNeedsRehash(env, user) {
  const want = iterationsOf(env);
  const scheme = String(user.pw_scheme || "");
  const hasPepper = !!String((env && env.PASSWORD_PEPPER) || "");
  if (scheme === "pbkdf2" && hasPepper) return true;
  if (scheme === "pbkdf2p" && !hasPepper) return true;
  return Number(user.pw_iter) < want;
}

/* ---------------- 输入校验 ---------------- */

const USERNAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{2,20}$/;
const DECK_ID_RE = /^[a-z0-9]{8,24}$/;
const VARIANTS = new Set(["", "evo", "hero", "champ"]);
const THEMES = new Set(["light", "space", "neon"]);

export function normUsername(v) {
  return String(v == null ? "" : v).normalize("NFKC").trim();
}
export function validUsername(v) {
  return USERNAME_RE.test(v);
}
export function validPassword(v) {
  return typeof v === "string" && v.length >= 6 && v.length <= 72;
}

export function validDeckId(v) {
  return DECK_ID_RE.test(String(v || ""));
}

/** 校验一套卡组：8 张卡、id 为非负整数、形态合法。返回规范化后的对象或 null。 */
export function sanitizeDeck(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!validDeckId(raw.id)) return null;
  const name = String(raw.name == null ? "" : raw.name).slice(0, 40) || "未命名卡组";
  const tower = Number(raw.tower);
  if (!Number.isInteger(tower) || tower < 100000000 || tower >= 1000000000) return null;
  if (!Array.isArray(raw.cards) || raw.cards.length !== 8) return null;
  const cards = [];
  for (const c of raw.cards) {
    if (!c || typeof c !== "object") return null;
    const id = Number(c.id);
    if (!Number.isInteger(id) || id < 0 || id >= 1000000000) return null;
    const v = String(c.v == null ? "" : c.v);
    if (!VARIANTS.has(v)) return null;
    cards.push({ id, v });
  }
  const ua = Number(raw.updatedAt);
  const now = Date.now();
  // 夹到 [0, now + 5min]：防止客户端时钟跑偏导致某一端永远赢
  const updatedAt = Number.isFinite(ua) ? Math.min(Math.max(Math.round(ua), 0), now + 5 * 60 * 1000) : now;
  const si = Number(raw.sort);
  return { id: raw.id, name, cards, tower, updatedAt, sort: Number.isInteger(si) && si >= 0 ? si : 0 };
}

export function validTheme(v) {
  return THEMES.has(String(v || ""));
}

/* ---------------- 请求解析 ---------------- */

export async function readBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared && declared > MAX_BODY) return { error: "too_large" };
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: "bad_body" };
  }
  if (!text) return { data: {} };
  if (text.length > MAX_BODY) return { error: "too_large" };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "bad_body" };
    return { data: v };
  } catch {
    return { error: "bad_body" };
  }
}

export function clientIp(context) {
  const h = context.request.headers;
  return String(h.get("cf-connecting-ip") || h.get("x-forwarded-for") || "0.0.0.0").split(",")[0].trim();
}

/* ---------------- Cookie / 会话 ---------------- */

export function parseCookies(request) {
  const raw = request.headers.get("Cookie") || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, maxAgeSec) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function tokenHashOf(env, token) {
  return sha256hex(token + String((env && env.SESSION_PEPPER) || ""));
}

/** 读取当前会话；过期或不存在返回 null。滑动续期，但有 90 天硬上限。 */
export async function getSession(context) {
  const db = context.env.CR_DB;
  const token = parseCookies(context.request)[SESSION_COOKIE];
  if (!token || !HEX64.test(token)) return null;
  const th = await tokenHashOf(context.env, token);
  const row = await db.prepare(
    "SELECT s.user_id, s.created_at, s.expires_at, s.seen_at, u.username FROM sessions s " +
    "JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).bind(th).first();
  if (!row) return null;

  const now = Date.now();
  if (Number(row.expires_at) <= now) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(th).run();
    return null;
  }
  const hardDeadline = Number(row.created_at) + SESSION_MAX_MS;
  const nextExpiry = Math.min(now + SESSION_TTL_MS, hardDeadline);
  const session = {
    tokenHash: th,
    userId: row.user_id,
    username: row.username,
    createdAt: Number(row.created_at),
    expiresAt: nextExpiry,
  };
  // 每天最多续期写一次，避免每个请求都写库
  let setCookie;
  if (now - Number(row.seen_at) > 24 * 3600 * 1000 || nextExpiry !== Number(row.expires_at)) {
    await db.prepare("UPDATE sessions SET seen_at = ?, expires_at = ? WHERE token_hash = ?")
      .bind(now, nextExpiry, th).run();
    setCookie = sessionCookie(token, Math.max(60, Math.floor((nextExpiry - now) / 1000)));
  }
  return { session, setCookie };
}

export async function createSession(env, db, userId) {
  const token = randomToken();
  const th = await tokenHashOf(env, token);
  const now = Date.now();
  await db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, seen_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(th, userId, now, now + SESSION_TTL_MS, now).run();
  return token;
}

/* ---------------- 限流 ---------------- */

/**
 * 简易固定窗口限流。D1 没有原子自增，这里用「读 → 写」两步；
 * 并发下偶尔会多放过一两个请求，对战队内部使用足够了。
 */
export async function rateLimit(db, bucket, limit, windowMs) {
  const now = Date.now();
  const row = await db.prepare("SELECT count, window_at FROM auth_limits WHERE bucket = ?").bind(bucket).first();
  if (!row || now - Number(row.window_at) > windowMs) {
    await db.prepare(
      "INSERT INTO auth_limits (bucket, count, window_at) VALUES (?, 1, ?) " +
      "ON CONFLICT(bucket) DO UPDATE SET count = 1, window_at = ?"
    ).bind(bucket, now, now).run();
    return { ok: true };
  }
  if (Number(row.count) >= limit) {
    return { ok: false, retryAfterMs: windowMs - (now - Number(row.window_at)) };
  }
  await db.prepare("UPDATE auth_limits SET count = count + 1 WHERE bucket = ?").bind(bucket).run();
  return { ok: true };
}

export async function cleanupLimits(db) {
  // 顺手清掉 1 天前的限流记录，避免表无限增长
  await db.prepare("DELETE FROM auth_limits WHERE window_at < ?").bind(Date.now() - 24 * 3600 * 1000).run();
}
