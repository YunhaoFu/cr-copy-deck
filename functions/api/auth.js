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
  parseCookies, tokenHashOf, rateLimit, rateLimitPeek, rateLimitHit, clearBucket,
  cleanupLimits, cleanupSessions, userBucketKey, SESSION_COOKIE,
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
  // 传原始值给 validPassword：先 String(...) 会把它里面的 typeof 检查变成死代码，
  // 于是 password: {} 这种能用 "[object Object]" 注册成功
  const password = data.password;
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
    // 只有唯一索引冲突才算重名；D1 故障不能被伪装成「这个用户名已注册」
    if (/unique|constraint/i.test(String(e && e.message))) return fail("username_taken", 409);
    throw e;
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

const LOGIN_WINDOW = 10 * 60 * 1000;   // 失败计数的滑动窗口
const LOGIN_MAX_FAILS = 20;            // 窗口内允许的失败次数
const LOGIN_IP_MAX = 30;               // 同一 IP 在 15 分钟内的总尝试次数
const LOGIN_IP_WINDOW = 15 * 60 * 1000;

async function login(context, db, data) {
  const username = normUsername(data.username);
  const password = data.password;
  // 用户名先用注册时的同一套规则挡一道：既避免拿超长字符串去算哈希 / 建桶，
  // 也保证这里不会因为畸形输入走到下面去跑 PBKDF2。
  if (!validUsername(username) || !validPassword(password)) return fail("bad_credentials", 401);
  const lc = username.toLowerCase();

  // IP 维度：统计所有尝试，兜住撞库
  const ipKey = await sha256hex(clientIp(context));
  const byIp = await rateLimit(db, `login:ip:${ipKey}`, LOGIN_IP_MAX, LOGIN_IP_WINDOW);
  if (!byIp.ok) return fail("rate_limited", 429);

  // 账号维度：桶键用哈希，不把用户名明文写进 auth_limits（也免得超长名字撑大表）；
  // 而且只统计失败次数 —— 成功登录不计，否则队友在几台设备间来回登录就会被锁
  const bucket = await userBucketKey(context.env, "login:u:", lc);
  const peek = await rateLimitPeek(db, bucket, LOGIN_MAX_FAILS, LOGIN_WINDOW);
  if (!peek.ok) return fail("rate_limited", 429);

  const user = await db.prepare("SELECT * FROM users WHERE username_lc = ?").bind(lc).first();
  if (!user) {
    await rateLimitHit(db, bucket, LOGIN_WINDOW);
    return fail("bad_credentials", 401);
  }
  const ok = await verifyPassword(context.env, password, user);
  if (!ok) {
    await rateLimitHit(db, bucket, LOGIN_WINDOW);
    return fail("bad_credentials", 401);
  }

  await clearBucket(db, bucket);   // 登录成功 → 该账号的失败计数归零

  // 迭代次数或 pepper 配置变了就顺手升级，用户无感
  if (passwordNeedsRehash(context.env, user)) {
    try {
      const pw = await hashPassword(context.env, password);
      await db.prepare("UPDATE users SET pw_scheme = ?, pw_iter = ?, pw_salt = ?, pw_hash = ?, updated_at = ? WHERE id = ?")
        .bind(pw.scheme, pw.iter, pw.salt, pw.hash, Date.now(), user.id).run();
    } catch { /* 升级失败不影响本次登录 */ }
  }

  // 过期会话平时没人清（只在被再次提交时才删），顺手收一次
  await cleanupSessions(db, user.id).catch(() => {});

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
  const password = data.password;              // 传原始值给 validPassword（见 register 的说明）
  if (!validUsername(username) || !code) return fail("bad_recovery", 400);
  if (!validPassword(password)) return fail("weak_password", 400);

  const ipKey = await sha256hex(clientIp(context));
  const lc = username.toLowerCase();
  const byIp = await rateLimit(db, `reset:ip:${ipKey}`, 10, HOUR);
  if (!byIp.ok) return fail("rate_limited", 429);
  // 同 login：桶键用哈希，避免把用户名明文写进 auth_limits
  const byUser = await rateLimit(db, await userBucketKey(context.env, "reset:u:", lc), 5, HOUR);
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
