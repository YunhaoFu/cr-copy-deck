/**
 * GET /api/sync —— 拉取该用户在云端的全部数据
 * PUT /api/sync —— 推送本地全量数据，服务端按「逐条时间戳 LWW」合并后回权威结果
 *
 * 合并规则（不需要 baseRev，天然幂等）：
 *   · 一套卡组：客户端时间戳 > 服务端记录的时间戳（取 updated_at 与 deleted_at 的较大者）才写入；
 *   · 墓碑（删除）：同样按时间戳比较，所以「删了又被另一台设备改过」时以更晚的动作为准；
 *   · 设置 / 主题：各自独立按时间戳 LWW，互不覆盖；
 *   · 客户端时间戳服务端会夹到 [0, now+5min]，客户端再用 serverTime 修正时钟偏差。
 */
import {
  json, fail, notConfigured, readBody, getSession, sanitizeDeck,
  validTheme, validDeckId, MAX_DECKS, MAX_SETTINGS_LEN, TOMBSTONE_TTL_MS,
} from "../_lib/store.js";

const MAX_SKEW_MS = 5 * 60 * 1000;

export async function onRequestGet(context) {
  const db = context.env.CR_DB;
  if (!db) return notConfigured();

  const s = await getSession(context);
  if (!s) return json({ ok: false, error: "unauthorized" }, 401);

  const state = await loadState(db, s.session.userId);
  const headers = s.setCookie ? { "set-cookie": s.setCookie } : {};
  return json({ ok: true, serverTime: Date.now(), ...publicState(state) }, 200, headers);
}

export async function onRequestPut(context) {
  const db = context.env.CR_DB;
  if (!db) return notConfigured();

  const s = await getSession(context);
  if (!s) return json({ ok: false, error: "unauthorized" }, 401);
  const uid = s.session.userId;

  const { data, error } = await readBody(context.request);
  if (error === "too_large") return fail("too_large", 413);
  if (error) return fail("bad_body", 400);

  /* ---- 校验入参 ---- */
  const rawDecks = Array.isArray(data.decks) ? data.decks : [];
  if (rawDecks.length > MAX_DECKS) return fail("too_many_decks", 413);
  const decks = [];
  for (const d of rawDecks) {
    const sd = sanitizeDeck(d);
    if (!sd) return fail("invalid_deck", 400);
    decks.push(sd);
  }

  const rawDeleted = Array.isArray(data.deleted) ? data.deleted : [];
  if (rawDeleted.length > MAX_DECKS * 4) return fail("too_many_deleted", 413);
  const now = Date.now();
  const deleted = [];
  for (const t of rawDeleted) {
    if (!t || !validDeckId(t.id)) return fail("invalid_deck", 400);
    const at = Number(t.at);
    // 墓碑是破坏性操作：时间戳缺失/非法就明确报错，不要默认成 now ——
    // 否则畸形客户端能删掉账号里其它设备的数据。客户端本来就总是带 at。
    if (!Number.isFinite(at)) return fail("invalid_deck", 400);
    const stamp = Math.min(Math.max(Math.round(at), 0), now + MAX_SKEW_MS);
    deleted.push({ id: t.id, at: stamp });
  }

  const settings = data.settings == null ? null : sanitizeSettings(data.settings);
  if (data.settings != null && !settings) return fail("invalid_settings", 400);
  if (settings && JSON.stringify(settings).length > MAX_SETTINGS_LEN) return fail("too_large", 413);

  const theme = validTheme(data.theme) ? String(data.theme) : null;
  // 非法时间戳一律当 0（永远输），不要回退成 now ——
  // 回退成 now 等于把畸形客户端当成"此刻的修改"，能顶掉别的设备的新版本。
  const stampOf = v => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), now + MAX_SKEW_MS) : 0;
  };
  const settingsAt = stampOf(data.settingsAt);
  const themeAt = stampOf(data.themeAt);

  /* ---- 合并 ---- */
  const state = await loadState(db, uid);
  const existing = new Map(state.rows.map(r => [r.id, r]));

  const stmts = [];
  let appliedDecks = 0;

  for (const d of decks) {
    const cur = existing.get(d.id);
    const curStamp = cur ? Math.max(cur.updatedAt, cur.deletedAt || 0) : -1;
    if (d.updatedAt <= curStamp) continue;                 // 服务端已有更新的版本（含删除），跳过
    stmts.push(db.prepare(
      "INSERT INTO decks (user_id, deck_id, name, cards, tower, sort_idx, updated_at, deleted_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, NULL) " +
      "ON CONFLICT(user_id, deck_id) DO UPDATE SET " +
      "name = excluded.name, cards = excluded.cards, tower = excluded.tower, " +
      "sort_idx = excluded.sort_idx, updated_at = excluded.updated_at, deleted_at = NULL"
    ).bind(uid, d.id, d.name, JSON.stringify(d.cards), d.tower, d.sort, d.updatedAt));
    appliedDecks++;
  }

  let appliedDeletes = 0;
  for (const t of deleted) {
    const cur = existing.get(t.id);
    if (!cur) {
      // 服务端没有这套卡组：墓碑本身也要落库，否则别的设备会一直把它推回来
      stmts.push(db.prepare(
        "INSERT INTO decks (user_id, deck_id, name, cards, tower, sort_idx, updated_at, deleted_at) " +
        "VALUES (?, ?, '', '[]', 0, 0, ?, ?) " +
        "ON CONFLICT(user_id, deck_id) DO NOTHING"
      ).bind(uid, t.id, t.at, t.at));
      appliedDeletes++;
      continue;
    }
    const curStamp = Math.max(cur.updatedAt, cur.deletedAt || 0);
    if (t.at < curStamp) continue;                          // 删除发生在一次更晚的编辑之前 → 忽略
    stmts.push(db.prepare(
      "UPDATE decks SET deleted_at = ?, name = '', cards = '[]' WHERE user_id = ? AND deck_id = ?"
    ).bind(t.at, uid, t.id));
    appliedDeletes++;
  }

  for (let i = 0; i < stmts.length; i += 50) {
    await db.batch(stmts.slice(i, i + 50));
  }

  /* ---- 设置 / 主题：各自 LWW，一条 upsert 搞定 ---- */
  // 没传的那一半把时间戳置 0，CASE 条件必然不成立，从而保留服务端原值。
  const appliedSettings = !!settings && settingsAt > state.settingsAt;
  const appliedTheme = !!theme && themeAt > state.themeAt;
  if (appliedSettings || appliedTheme) {
    const bindSettings = settings ? JSON.stringify(settings) : JSON.stringify(state.settings || {});
    const bindTheme = theme || state.theme || "light";
    await db.prepare(
      "INSERT INTO user_settings (user_id, settings, settings_at, theme, theme_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET " +
      "settings = CASE WHEN excluded.settings_at > user_settings.settings_at THEN excluded.settings ELSE user_settings.settings END, " +
      "settings_at = CASE WHEN excluded.settings_at > user_settings.settings_at THEN excluded.settings_at ELSE user_settings.settings_at END, " +
      "theme = CASE WHEN excluded.theme_at > user_settings.theme_at THEN excluded.theme ELSE user_settings.theme END, " +
      "theme_at = CASE WHEN excluded.theme_at > user_settings.theme_at THEN excluded.theme_at ELSE user_settings.theme_at END"
    ).bind(uid, bindSettings, settings ? settingsAt : 0, bindTheme, theme ? themeAt : 0).run();
  }

  /* ---- 收尾：清过期墓碑 + 更新版本号 ---- */
  const changed = appliedDecks + appliedDeletes > 0 || appliedSettings || appliedTheme;
  const finalStmts = [
    db.prepare("DELETE FROM decks WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?")
      .bind(uid, now - TOMBSTONE_TTL_MS),
    // 兜底：本次请求开头读到会话之后、写到库里之前，账号有可能刚好被注销
    // （DELETE /api/me）。那样就会留下谁也读不到的孤儿行。
    // 在同一个 batch 里自查一次，保证「账号没了 = 数据也没了」。
    db.prepare("DELETE FROM decks WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE id = ?)")
      .bind(uid, uid),
    db.prepare("DELETE FROM user_settings WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE id = ?)")
      .bind(uid, uid),
  ];
  if (changed) {
    finalStmts.push(db.prepare("UPDATE users SET data_rev = data_rev + 1, updated_at = ? WHERE id = ?").bind(now, uid));
  }
  await db.batch(finalStmts);

  const after = await loadState(db, uid);
  const headers = s.setCookie ? { "set-cookie": s.setCookie } : {};
  return json({
    ok: true,
    serverTime: Date.now(),
    ...publicState(after),
    applied: { decks: appliedDecks, deleted: appliedDeletes, settings: appliedSettings, theme: appliedTheme },
  }, 200, headers);
}

/* ---------------- 内部 ---------------- */

async function loadState(db, uid) {
  const [userRes, deckRes, setRes] = await db.batch([
    db.prepare("SELECT data_rev FROM users WHERE id = ?").bind(uid),
    db.prepare(
      "SELECT deck_id, name, cards, tower, sort_idx, updated_at, deleted_at FROM decks " +
      "WHERE user_id = ? ORDER BY sort_idx ASC, updated_at DESC"
    ).bind(uid),
    db.prepare("SELECT settings, settings_at, theme, theme_at FROM user_settings WHERE user_id = ?").bind(uid),
  ]);

  const rows = [];
  const deckList = [];
  const tombstones = [];
  for (const r of (deckRes.results || [])) {
    const row = {
      id: r.deck_id,
      name: r.name,
      cards: safeJson(r.cards, []),
      tower: Number(r.tower) || 0,
      sort: Number(r.sort_idx) || 0,
      updatedAt: Number(r.updated_at) || 0,
      deletedAt: r.deleted_at == null ? null : Number(r.deleted_at),
    };
    rows.push(row);
    if (row.deletedAt) tombstones.push({ id: row.id, at: row.deletedAt });
    else if (Array.isArray(row.cards) && row.cards.length === 8) deckList.push(row);
  }

  const sr = (setRes.results || [])[0];
  const settings = sr ? {
    value: safeJson(sr.settings, {}),
    settingsAt: Number(sr.settings_at) || 0,
    theme: validTheme(sr.theme) ? String(sr.theme) : "light",
    themeAt: Number(sr.theme_at) || 0,
  } : null;

  const ur = (userRes.results || [])[0];
  return {
    rev: Number((ur && ur.data_rev) || 0),
    rows,
    decks: deckList.map(d => ({ id: d.id, name: d.name, cards: d.cards, tower: d.tower, sort: d.sort, updatedAt: d.updatedAt })),
    tombstones,
    settings: settings ? settings.value : null,
    settingsAt: settings ? settings.settingsAt : 0,
    theme: settings ? settings.theme : "light",
    themeAt: settings ? settings.themeAt : 0,
  };
}

/** rows 是内部结构（含墓碑占位行），不对外暴露 */
function publicState(s) {
  return {
    rev: s.rev, decks: s.decks, tombstones: s.tombstones,
    settings: s.settings, settingsAt: s.settingsAt, theme: s.theme, themeAt: s.themeAt,
  };
}

function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 与前端 loadSettings() 同构的轻量规范化，避免把任意 JSON 塞进库里。 */
function sanitizeSettings(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const out = {};
  if (typeof s.label === "string" && s.label && s.label.length <= 40) out.label = s.label;
  if (typeof s.tt === "string" && /^\d{1,12}$/.test(s.tt)) out.tt = s.tt;
  if (typeof s.emitSlots === "boolean") out.emitSlots = s.emitSlots;
  if (s.codes && typeof s.codes === "object" && !Array.isArray(s.codes)) {
    out.codes = {};
    for (const k of ["evo", "hero"]) {
      if (typeof s.codes[k] === "string" && s.codes[k].length <= 8) out.codes[k] = s.codes[k];
    }
  }
  if (Array.isArray(s.rules) && s.rules.length === 8) {
    out.rules = s.rules.map(r => ({
      evo: !!(r && r.evo),
      hero: !!(r && r.hero),
      champ: !!(r && (r.champ ?? r.elite)),
    }));
  }
  return Object.keys(out).length ? out : null;
}
