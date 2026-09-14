/**
 * GET    /api/me  —— 当前登录状态（用户名 / 云端版本号 / 卡组数）
 * DELETE /api/me  —— 注销账号：删除该用户在云端的全部数据（卡组、设置、会话）
 */
import {
  json, fail, notConfigured, readBody, getSession, clearSessionCookie,
} from "../_lib/store.js";

export async function onRequestGet(context) {
  const db = context.env.CR_DB;
  if (!db) return notConfigured();

  const s = await getSession(context);
  if (!s) return json({ ok: false, error: "unauthorized" }, 401);

  const user = await db.prepare("SELECT data_rev FROM users WHERE id = ?").bind(s.session.userId).first();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  const cnt = await db.prepare(
    "SELECT COUNT(*) AS n FROM decks WHERE user_id = ? AND deleted_at IS NULL"
  ).bind(s.session.userId).first();

  const headers = s.setCookie ? { "set-cookie": s.setCookie } : {};
  return json({
    ok: true,
    user: { username: s.session.username },
    rev: Number(user.data_rev) || 0,
    deckCount: Number((cnt && cnt.n) || 0),
  }, 200, headers);
}

export async function onRequestDelete(context) {
  const db = context.env.CR_DB;
  if (!db) return notConfigured();

  const s = await getSession(context);
  if (!s) return json({ ok: false, error: "unauthorized" }, 401);

  const { data, error } = await readBody(context.request);
  if (error) return fail("bad_body", 400);
  if (String(data.confirm || "") !== "DELETE") return fail("confirm_required", 400);

  const uid = s.session.userId;
  await db.batch([
    db.prepare("DELETE FROM decks WHERE user_id = ?").bind(uid),
    db.prepare("DELETE FROM user_settings WHERE user_id = ?").bind(uid),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(uid),
    db.prepare("DELETE FROM users WHERE id = ?").bind(uid),
  ]);

  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}
