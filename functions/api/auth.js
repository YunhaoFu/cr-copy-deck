/**
 * POST /api/auth —— 注册 / 登录 / 退出 / 用恢复码重置密码
 *
 * 只用「用户名 + 密码」，不收集邮箱等任何个人信息，也不发任何邮件。
 * 忘记密码靠注册时展示一次的那串恢复码。
 */
import {
  json, fail, notConfigured, readBody, clientIp, normUsername, validUsername,
  validPassword, hashPassword, verifyPassword, passwordNeedsRehash,
  randomId, randomRecoveryCode, normRecoveryCode, sha256hex, ctEqual,
  createSession, sessionCookie, clearSessionCookie,
  parseCookies, tokenHashOf, rateLimit, cleanupLimits, SESSION_COOKIE,
} from "../_lib/store.js";

const HOUR = 3600 * 1000;

export async function onRequestPost(context) {
  const db = context.env.CR_DB;
  if (!db) return notConfigured();

  const { data, error } = await readBody(context.request);
  if (error === "too_large") return fail("too_large", 413);
  if (error) return fail("bad_body", 400);

  switch (String(data.action || "")) {
    case "register": return register(context, db, data);
    case "login":    return login(context, db, data);
    case "logout":   return logout(context, db);
    case "reset":    return reset(context, db, data);
    default:         return fail("unknown_action", 400);
  }
}

/* ---------------- 注册 ---------------- */

async function register(context, db, data) {
  const username = normUsername(data.username);
  if (!validUsername(username)) return fail("invalid_username", 400);
  const password = String(data.password || "");
  if (!validPassword(password)) return fail("weak_password", 400);

  const ip = clientIp(context);
  const ipKey = await sha256hex(ip);
  const rl = await rateLimit(db, `reg:${ipKey}`, 10, HOUR);
  if (!rl.ok) return fail("rate_limited", 429);

  const lc = username.toLowerCase();
  const exists = await db.prepare("SELECT 1 AS x FROM users WHERE username_lc = ?").bind(lc).first();
  if (exists) return fail("username_taken", 409);

  const pw = await hashPassword(context.env, password);
  const recoveryCode = randomRecoveryCode();
  const rcHash = await sha256hex(normRecoveryCode(recoveryCode) + String(context.env.PASSWORD_PEPPER || ""));
  const now = Date.now();
  const userId = randomId(16);

  try {
    await db.prepare(
      "INSERT INTO users (id, username, username_lc, pw_scheme, pw_iter, pw_salt, pw_hash, rc_hash, data_rev, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)"
    ).bind(userId, username, lc, pw.scheme, pw.iter, pw.salt, pw.hash, rcHash, now, now).run();
  } catch (e) {
    // 并发抢注同一个名字 → 唯一索引兜底
    return fail("username_taken", 409);
  }

  const token = await createSession(context.env, db, userId);
  context.waitUntil(cleanupLimits(db).catch(() => {}));
  return json(
    { ok: true, user: { username }, recoveryCode },
    201,
    { "set-cookie": sessionCookie(token, 30 * 24 * 3600) }
  );
}

/* ---------------- 登录 ---------------- */

async function login(context, db, data) {
  const username = normUsername(data.username);
  const password = String(data.password || "");
  if (!username || !password) return fail("bad_credentials", 401);

  const ipKey = await sha256hex(clientIp(context));
  const lc = username.toLowerCase();
  const byIp = await rateLimit(db, `login:${ipKey}`, 30, 15 * 60 * 1000);
  if (!byIp.ok) return fail("rate_limited", 429);
  const byUser = await rateLimit(db, `login:u:${lc}`, 10, 15 * 60 * 1000);
  if (!byUser.ok) return fail("rate_limited", 429);

  const user = await db.prepare("SELECT * FROM users WHERE username_lc = ?").bind(lc).first();
  if (!user) return fail("bad_credentials", 401);
  const ok = await verifyPassword(context.env, password, user);
  if (!ok) return fail("bad_credentials", 401);

  // 迭代次数或 pepper 配置变了就顺手升级，用户无感
  if (passwordNeedsRehash(context.env, user)) {
    try {
      const pw = await hashPassword(context.env, password);
      await db.prepare("UPDATE users SET pw_scheme = ?, pw_iter = ?, pw_salt = ?, pw_hash = ?, updated_at = ? WHERE id = ?")
        .bind(pw.scheme, pw.iter, pw.salt, pw.hash, Date.now(), user.id).run();
    } catch { /* 升级失败不影响本次登录 */ }
  }

  const token = await createSession(context.env, db, user.id);
  return json(
    { ok: true, user: { username: user.username } },
    200,
    { "set-cookie": sessionCookie(token, 30 * 24 * 3600) }
  );
}

/* ---------------- 退出 ---------------- */

async function logout(context, db) {
  const token = parseCookies(context.request)[SESSION_COOKIE];
  if (token) {
    const th = await tokenHashOf(context.env, token);
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(th).run();
  }
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

/* ---------------- 用恢复码重置密码 ---------------- */

async function reset(context, db, data) {
  const username = normUsername(data.username);
  const code = normRecoveryCode(data.recoveryCode);
  const password = String(data.password || "");
  if (!username || !code) return fail("bad_recovery", 400);
  if (!validPassword(password)) return fail("weak_password", 400);

  const ipKey = await sha256hex(clientIp(context));
  const lc = username.toLowerCase();
  const byIp = await rateLimit(db, `reset:${ipKey}`, 10, HOUR);
  if (!byIp.ok) return fail("rate_limited", 429);
  const byUser = await rateLimit(db, `reset:u:${lc}`, 5, HOUR);
  if (!byUser.ok) return fail("rate_limited", 429);

  const user = await db.prepare("SELECT id, rc_hash FROM users WHERE username_lc = ?").bind(lc).first();
  if (!user || !user.rc_hash) return fail("bad_recovery", 400);

  const got = await sha256hex(code + String(context.env.PASSWORD_PEPPER || ""));
  if (!ctEqual(got, String(user.rc_hash).toLowerCase())) return fail("bad_recovery", 400);

  const pw = await hashPassword(context.env, password);
  const recoveryCode = randomRecoveryCode();                 // 旧恢复码作废，发新的
  const rcHash = await sha256hex(normRecoveryCode(recoveryCode) + String(context.env.PASSWORD_PEPPER || ""));
  const now = Date.now();

  await db.prepare(
    "UPDATE users SET pw_scheme = ?, pw_iter = ?, pw_salt = ?, pw_hash = ?, rc_hash = ?, updated_at = ? WHERE id = ?"
  ).bind(pw.scheme, pw.iter, pw.salt, pw.hash, rcHash, now, user.id).run();

  // 改密后踢掉所有旧会话
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run();

  const token = await createSession(context.env, db, user.id);
  return json(
    { ok: true, recoveryCode },
    200,
    { "set-cookie": sessionCookie(token, 30 * 24 * 3600) }
  );
}
