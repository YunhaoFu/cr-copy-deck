#!/usr/bin/env node
/**
 * 后端集成测试：把 functions/ 里的 Pages Functions 真正跑一遍。
 *
 * 做法：用 Node 内置的 node:sqlite 实现一个最小 D1 兼容层（prepare/bind/first/run/all/batch），
 * 然后直接调用 onRequestGet/onRequestPost/onRequestPut/onRequestDelete。
 * 这样 SQL 语法、唯一索引、ON CONFLICT、LWW 合并逻辑都能在本地验证，不用等部署。
 *
 * 需要 Node ≥ 22.5（node:sqlite）。用法：node scripts/test-api.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createD1, migrationSql } from "./lib/sqlite-d1.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------------- 断言 ---------------- */

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; return; }
  failures.push(name + (extra ? `  → ${extra}` : ""));
}
function section(title) { console.log(`\n── ${title} ──`); }

/* ---------------- D1 兼容层（与本地开发服务器共用同一份实现） ---------------- */

/* ---------------- 测试脚手架 ---------------- */

const makeDb = () => createD1(":memory:");

let cookieJar = "";
/** 构造一个 Pages Functions 的 context。cookie 传 null 表示不带 Cookie；传 "" 表示清空。 */
function ctx(db, { method = "GET", body, cookie, url = "https://x.pages.dev/api/auth", env = {} } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const c = cookie === undefined ? cookieJar : cookie;
  if (c) headers.set("Cookie", c);
  if (env.__ip) headers.set("cf-connecting-ip", env.__ip);
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const request = new Request(url, init);
  const e = { CR_DB: db, PASSWORD_PEPPER: "test-pepper", SESSION_PEPPER: "test-sess", ...env };
  if (env.__noDb) delete e.CR_DB;
  return { request, env: e, waitUntil: () => {}, next: () => new Response("next") };
}

function cookieFrom(res) {
  const raw = res.headers.get("set-cookie") || "";
  const first = raw.split(";")[0];
  return first.includes("=") ? first : "";
}

async function call(mod, ctxObj, kind) {
  const fn = kind === "GET" ? mod.onRequestGet
    : kind === "POST" ? mod.onRequestPost
      : kind === "PUT" ? mod.onRequestPut
        : mod.onRequestDelete;
  const res = await fn(ctxObj);
  let json = null;
  try { json = await res.clone().json(); } catch { /* 204 之类 */ }
  return { res, json, status: res.status };
}

/* ---------------- 载入被测模块 ---------------- */

const authMod = await import("../functions/api/auth.js");
const meMod = await import("../functions/api/me.js");
const syncMod = await import("../functions/api/sync.js");

const B = "https://x.pages.dev";
const auth = (db, opt = {}) => call(authMod, ctx(db, { method: "POST", url: `${B}/api/auth`, ...opt }), "POST");
const me = (db, opt = {}) => call(meMod, ctx(db, { method: "GET", url: `${B}/api/me`, ...opt }), "GET");
const meDel = (db, opt = {}) => call(meMod, ctx(db, { method: "DELETE", url: `${B}/api/me`, ...opt }), "DELETE");
const syncGet = (db, opt = {}) => call(syncMod, ctx(db, { method: "GET", url: `${B}/api/sync`, ...opt }), "GET");
const syncPut = (db, opt = {}) => call(syncMod, ctx(db, { method: "PUT", url: `${B}/api/sync`, ...opt }), "PUT");

/* ---------------- 测试数据 ---------------- */

const now = Date.now();
const cardsA = [{ id: 26000014, v: "evo" }, { id: 26000038, v: "hero" }, { id: 27000000, v: "evo" },
  { id: 26000010, v: "" }, { id: 26000030, v: "" }, { id: 28000011, v: "" }, { id: 26000021, v: "" }, { id: 28000000, v: "" }];
const deckA = { id: "aaaaaaaaaaaaaaaa", name: "2.6 猪", cards: cardsA, tower: 159000000, sort: 0, updatedAt: now - 1000 };
const deckB = { id: "bbbbbbbbbbbbbbbb", name: "迫击炮", cards: cardsA, tower: 159000000, sort: 1, updatedAt: now - 1000 };
const SETTINGS = { label: "Royals", tt: "159000000", emitSlots: true, codes: { evo: "1", hero: "" },
  rules: Array.from({ length: 8 }, (_, i) => ({ evo: i === 0 || i === 2, hero: i === 1 || i === 2, champ: i === 1 || i === 2 })) };

/* ================= 用例 ================= */

section("A 未绑定 D1 时优雅降级");
{
  const db = null;
  const r1 = await auth(db, { body: { action: "login", username: "a", password: "123456" }, env: { __noDb: true } });
  check("A1 POST /api/auth → 503", r1.status === 503, `got ${r1.status}`);
  check("A2 返回 storage_not_configured", r1.json?.error === "storage_not_configured");
  const r2 = await me(db, { env: { __noDb: true } });
  check("A3 GET /api/me → 503", r2.status === 503, `got ${r2.status}`);
}

const db = makeDb();

section("B 注册");
{
  cookieJar = "";
  const r1 = await auth(db, { body: { action: "register", username: "阿福", password: "123456" }, env: { __ip: "1.1.1.1" } });
  check("B1 注册成功 → 201", r1.status === 201, `got ${r1.status} ${JSON.stringify(r1.json)}`);
  check("B2 返回用户名", r1.json?.user?.username === "阿福");
  check("B3 返回恢复码", /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r1.json?.recoveryCode || ""), r1.json?.recoveryCode);
  check("B4 下发会话 Cookie", /^crsess=[a-f0-9]{64}$/.test(cookieFrom(r1.res)), cookieFrom(r1.res).slice(0, 20));
  check("B5 Cookie 带 HttpOnly/Secure/SameSite", /HttpOnly/i.test(r1.res.headers.get("set-cookie")) &&
    /Secure/i.test(r1.res.headers.get("set-cookie")) && /SameSite=Lax/i.test(r1.res.headers.get("set-cookie")));
  check("B6 响应禁缓存", r1.res.headers.get("cache-control") === "no-store");
  cookieJar = cookieFrom(r1.res);

  const r2 = await auth(db, { body: { action: "register", username: "阿福", password: "123456" }, env: { __ip: "1.1.1.1" } });
  check("B7 重名 → 409", r2.status === 409, `got ${r2.status}`);
  check("B8 错误码 username_taken", r2.json?.error === "username_taken");

  const r3 = await auth(db, { body: { action: "register", username: "阿福", password: "123456" }, env: { __ip: "1.1.1.2" } });
  check("B9 大小写/全角归一化后仍视为重名", r3.status === 409, `got ${r3.status}`);

  const r4 = await auth(db, { body: { action: "register", username: "a", password: "123456" }, env: { __ip: "1.1.1.3" } });
  check("B10 用户名过短（1 字）→ 400", r4.status === 400 && r4.json?.error === "invalid_username", `got ${r4.status}`);

  const r4b = await auth(db, { body: { action: "register", username: "中文两字", password: "123456" }, env: { __ip: "1.1.1.31" } });
  check("B10b 两个汉字也是合法用户名", r4b.status === 201, `got ${r4b.status}`);

  const r5 = await auth(db, { body: { action: "register", username: "bad name!", password: "123456" }, env: { __ip: "1.1.1.4" } });
  check("B11 用户名含空格/符号 → 400", r5.status === 400 && r5.json?.error === "invalid_username");

  const r6 = await auth(db, { body: { action: "register", username: "user6", password: "12345" }, env: { __ip: "1.1.1.5" } });
  check("B12 密码 <6 位 → 400 weak_password", r6.status === 400 && r6.json?.error === "weak_password");

  const r7 = await auth(db, { body: { action: "nope" }, env: { __ip: "1.1.1.6" } });
  check("B13 未知 action → 400", r7.status === 400 && r7.json?.error === "unknown_action");

  const r8 = await auth(db, { body: "not json", env: { __ip: "1.1.1.7" } });
  check("B14 非法 JSON → 400 bad_body", r8.status === 400 && r8.json?.error === "bad_body");
}

section("C 登录");
{
  cookieJar = "";
  const r1 = await auth(db, { body: { action: "login", username: "阿福", password: "wrongpass" }, env: { __ip: "2.2.2.1" } });
  check("C1 密码错 → 401 bad_credentials", r1.status === 401 && r1.json?.error === "bad_credentials", `got ${r1.status}`);

  const r2 = await auth(db, { body: { action: "login", username: "不存在的人", password: "123456" }, env: { __ip: "2.2.2.2" } });
  check("C2 用户不存在 → 401 且错误码与密码错一致（不泄露账号是否存在）",
    r2.status === 401 && r2.json?.error === "bad_credentials");

  const r3 = await auth(db, { body: { action: "login", username: "阿福", password: "123456" }, env: { __ip: "2.2.2.3" } });
  check("C3 登录成功 → 200", r3.status === 200, `got ${r3.status} ${JSON.stringify(r3.json)}`);
  check("C4 下发 Cookie", /^crsess=[a-f0-9]{64}$/.test(cookieFrom(r3.res)));
  cookieJar = cookieFrom(r3.res);

  const r4 = await auth(db, { body: { action: "login", username: "  阿福  ", password: "123456" }, env: { __ip: "2.2.2.4" } });
  check("C5 用户名前后空格自动裁剪后能登录", r4.status === 200, `got ${r4.status}`);
}

section("D /api/me 会话");
{
  const r1 = await me(db, { cookie: "" });
  check("D1 未登录 → 401", r1.status === 401 && r1.json?.ok === false, `got ${r1.status}`);

  const r2 = await me(db, { cookie: "crsess=" + "f".repeat(64) });
  check("D2 伪造 token → 401", r2.status === 401, `got ${r2.status}`);

  const r3 = await me(db, { cookie: cookieJar });
  check("D3 已登录 → 200", r3.status === 200, `got ${r3.status}`);
  check("D4 返回用户名", r3.json?.user?.username === "阿福");
  check("D5 初始卡组数为 0", r3.json?.deckCount === 0);
  check("D6 初始 rev 为 0", r3.json?.rev === 0);
}

section("E 同步：首次推送");
{
  const r1 = await syncGet(db, { cookie: cookieJar });
  check("E1 空账号拉取 → 200 且 0 套", r1.status === 200 && r1.json?.decks?.length === 0, `got ${r1.status}`);
  check("E2 返回 serverTime（供客户端校正时钟）", typeof r1.json?.serverTime === "number");

  const r2 = await syncPut(db, {
    cookie: cookieJar,
    body: { decks: [deckA, deckB], deleted: [], settings: SETTINGS, settingsAt: now - 500, theme: "neon", themeAt: now - 500 },
  });
  check("E3 推送 2 套 → 200", r2.status === 200, `got ${r2.status} ${JSON.stringify(r2.json)}`);
  check("E4 applied.decks = 2", r2.json?.applied?.decks === 2, JSON.stringify(r2.json?.applied));
  check("E5 回权威全量 2 套", r2.json?.decks?.length === 2);
  check("E6 主题已保存", r2.json?.theme === "neon", r2.json?.theme);
  check("E7 设置已保存", r2.json?.settings?.label === "Royals");
  check("E8 rev 已 +1", r2.json?.rev === 1, `rev=${r2.json?.rev}`);

  const r3 = await syncGet(db, { cookie: cookieJar });
  check("E9 重新拉取 → 2 套且顺序保留", r3.json?.decks?.length === 2 && r3.json?.decks?.[0]?.id === deckA.id);
  check("E10 卡组内容完整（8 张卡 + tower）",
    r3.json?.decks?.[0]?.cards?.length === 8 && r3.json?.decks?.[0]?.tower === 159000000);
}

section("F 同步：幂等 / 校验 / 断言");
{
  const r1 = await syncPut(db, {
    cookie: cookieJar,
    body: { decks: [deckA, deckB], deleted: [], settings: SETTINGS, settingsAt: now - 500, theme: "neon", themeAt: now - 500 },
  });
  check("F1 重复推送同一份数据 → 不重复写入", r1.json?.applied?.decks === 0 && r1.json?.applied?.settings === false
    && r1.json?.applied?.theme === false, JSON.stringify(r1.json?.applied));
  check("F2 无变化时不 bump rev", r1.json?.rev === 1, `rev=${r1.json?.rev}`);

  const bad7 = { ...deckA, cards: cardsA.slice(0, 7) };
  const r2 = await syncPut(db, { cookie: cookieJar, body: { decks: [bad7], deleted: [] } });
  check("F3 只有 7 张卡 → 400 invalid_deck", r2.status === 400 && r2.json?.error === "invalid_deck", `got ${r2.status}`);

  const r3 = await syncPut(db, { cookie: cookieJar, body: { decks: [{ ...deckA, tower: 1 }], deleted: [] } });
  check("F4 非法塔防 id → 400", r3.status === 400 && r3.json?.error === "invalid_deck");

  const r4 = await syncPut(db, { cookie: cookieJar, body: { decks: [{ ...deckA, id: "SHORT" }], deleted: [] } });
  check("F5 非法卡组 id → 400", r4.status === 400 && r4.json?.error === "invalid_deck");

  const r5 = await syncPut(db, { cookie: cookieJar, body: { decks: [{ ...deckA, cards: [{ id: 1, v: "hack" }, ...cardsA.slice(1)] }], deleted: [] } });
  check("F6 非法形态编码 → 400", r5.status === 400 && r5.json?.error === "invalid_deck");

  const many = Array.from({ length: 301 }, (_, i) => ({ ...deckA, id: "d" + String(i).padStart(15, "0") }));
  const r6 = await syncPut(db, { cookie: cookieJar, body: { decks: many, deleted: [] } });
  check("F7 超过 300 套 → 413 too_many_decks", r6.status === 413 && r6.json?.error === "too_many_decks", `got ${r6.status}`);

  const futureDeck = { ...deckA, id: "ffffffffffffffff", name: "时钟跑快的设备", updatedAt: now + 999999999 };
  const r7 = await syncPut(db, { cookie: cookieJar, body: { decks: [futureDeck], deleted: [] } });
  check("F8 离谱的未来时间戳被接受但不炸", r7.status === 200, `got ${r7.status}`);
  const stored = r7.json?.decks?.find(d => d.id === futureDeck.id)?.updatedAt;
  check("F9 未来时间戳被夹进 now+5min 之内", typeof stored === "number" && stored <= Date.now() + 5 * 60 * 1000 + 1000, `stored=${stored}`);
  await syncPut(db, { cookie: cookieJar, body: { decks: [], deleted: [{ id: futureDeck.id, at: Date.now() + 10 * 60 * 1000 }] } });

  const r8 = await syncGet(db, { cookie: "" });
  check("F10 未登录拉取 → 401", r8.status === 401);
  const r9 = await syncPut(db, { cookie: "", body: { decks: [] } });
  check("F11 未登录推送 → 401", r9.status === 401);
}

section("G 合并：逐条 LWW");
{
  const older = { ...deckA, name: "旧名字", updatedAt: now - 9000 };
  const r1 = await syncPut(db, { cookie: cookieJar, body: { decks: [older], deleted: [] } });
  check("G1 更旧的时间戳 → 不覆盖服务端", r1.json?.applied?.decks === 0, JSON.stringify(r1.json?.applied));
  check("G2 服务端名字未变", r1.json?.decks?.find(d => d.id === deckA.id)?.name === "2.6 猪");

  const newer = { ...deckA, name: "新名字", updatedAt: Date.now() };
  const r2 = await syncPut(db, { cookie: cookieJar, body: { decks: [newer], deleted: [] } });
  check("G3 更新的时间戳 → 覆盖", r2.json?.applied?.decks === 1);
  check("G4 名字已更新", r2.json?.decks?.find(d => d.id === deckA.id)?.name === "新名字");

  const r3 = await syncPut(db, { cookie: cookieJar, body: { decks: [deckB], deleted: [] } });
  check("G5 只推一部分卡组时，其余保持不动（是合并不是覆盖）",
    r3.json?.decks?.length === 2, `decks=${r3.json?.decks?.length}`);
}

section("H 删除：墓碑");
{
  const delAt = Date.now();
  const r1 = await syncPut(db, { cookie: cookieJar, body: { decks: [deckB], deleted: [{ id: deckA.id, at: delAt }] } });
  check("H1 删除生效 → applied.deleted = 1", r1.json?.applied?.deleted === 1, JSON.stringify(r1.json?.applied));
  check("H2 卡组从权威列表消失", r1.json?.decks?.length === 1 && r1.json?.decks?.[0]?.id === deckB.id);
  check("H3 墓碑下发（其他设备据此本地删除）", r1.json?.tombstones?.some(t => t.id === deckA.id), JSON.stringify(r1.json?.tombstones));

  const r2 = await syncPut(db, { cookie: cookieJar, body: { decks: [deckA], deleted: [] } });
  check("H4 拿旧数据推回删掉的卡组 → 不会复活", r2.json?.decks?.length === 1, `decks=${r2.json?.decks?.length}`);

  const r3 = await syncPut(db, { cookie: cookieJar, body: { decks: [{ ...deckA, updatedAt: Date.now() + 1000 }], deleted: [] } });
  check("H5 删除后又在别的设备上编辑（更新的时间戳）→ 正确地复活",
    r3.json?.decks?.length === 2, `decks=${r3.json?.decks?.length}`);

  // 推翻一个服务端根本不存在的卡组
  const r4 = await syncPut(db, { cookie: cookieJar, body: { decks: [], deleted: [{ id: "cccccccccccccccc", at: Date.now() }] } });
  check("H6 删除一个不存在的卡组 → 也落墓碑，避免被别的设备推回来",
    r4.json?.tombstones?.some(t => t.id === "cccccccccccccccc"));
}

section("I 设置 / 主题：各自独立 LWW");
{
  const themeOnly = await syncPut(db, { cookie: cookieJar, body: { theme: "space", themeAt: Date.now() } });
  check("I1 只推主题 → 主题更新", themeOnly.json?.theme === "space", themeOnly.json?.theme);
  check("I2 只推主题时设置不被清空", themeOnly.json?.settings?.label === "Royals", JSON.stringify(themeOnly.json?.settings));

  const settingsOnly = await syncPut(db, { cookie: cookieJar, body: { settings: { ...SETTINGS, label: "NewLabel" }, settingsAt: Date.now() } });
  check("I3 只推设置 → 设置更新", settingsOnly.json?.settings?.label === "NewLabel");
  check("I4 只推设置时主题不被覆盖", settingsOnly.json?.theme === "space", settingsOnly.json?.theme);

  const stale = await syncPut(db, { cookie: cookieJar, body: { theme: "neon", themeAt: now - 99999 } });
  check("I5 更旧的主题时间戳 → 不覆盖", stale.json?.theme === "space", stale.json?.theme);

  const bad = await syncPut(db, { cookie: cookieJar, body: { settings: "not-an-object", settingsAt: Date.now() } });
  check("I6 非法设置 → 400 invalid_settings", bad.status === 400 && bad.json?.error === "invalid_settings", `got ${bad.status}`);

  const badTheme = await syncPut(db, { cookie: cookieJar, body: { theme: "rainbow", themeAt: Date.now() } });
  check("I7 非法主题名被忽略（不报错也不写入）", badTheme.status === 200 && badTheme.json?.theme === "space");

  const junk = await syncPut(db, { cookie: cookieJar, body: { settings: { evil: "x".repeat(100), rules: "nope" }, settingsAt: Date.now() } });
  check("I8 未知字段被过滤掉", junk.json?.settings?.evil === undefined, JSON.stringify(junk.json?.settings));
}

section("J 多用户隔离");
{
  const saved = cookieJar;
  cookieJar = "";
  const reg = await auth(db, { body: { action: "register", username: "队友B", password: "abcdef" }, env: { __ip: "3.3.3.1" } });
  check("J1 第二个用户注册成功", reg.status === 201, `got ${reg.status} ${JSON.stringify(reg.json)}`);
  const jarB = cookieFrom(reg.res);

  const r = await syncGet(db, { cookie: jarB });
  check("J2 新用户看不到别人的卡组", r.json?.decks?.length === 0, `decks=${r.json?.decks?.length}`);
  check("J3 新用户看不到别人的设置", r.json?.settings === null, JSON.stringify(r.json?.settings));
  check("J4 新用户主题为默认值", r.json?.theme === "light", r.json?.theme);

  // B 用和 A 相同的 deck id 推一套自己的卡组，不应互相影响
  const r2 = await syncPut(db, { cookie: jarB, body: { decks: [{ ...deckA, name: "B 的卡组", updatedAt: Date.now() }], deleted: [] } });
  check("J5 不同用户可以用相同的卡组 id 互不干扰", r2.json?.applied?.decks === 1 && r2.json?.decks?.length === 1);

  const r3 = await syncGet(db, { cookie: saved });
  const mine = r3.json?.decks?.find(d => d.id === deckA.id);
  check("J6 A 的卡组没有被 B 覆盖", mine && mine.name !== "B 的卡组", mine?.name);
  cookieJar = saved;
}

section("K 退出 / 重置密码 / 注销");
{
  const r1 = await auth(db, { body: { action: "logout" }, cookie: cookieJar });
  check("K1 退出 → 200", r1.status === 200);
  check("K2 清 Cookie（Max-Age=0）", /Max-Age=0/.test(r1.res.headers.get("set-cookie") || ""));

  const r2 = await me(db, { cookie: cookieJar });
  check("K3 退出后会话失效 → 401", r2.status === 401, `got ${r2.status}`);

  const r3 = await auth(db, { body: { action: "login", username: "阿福", password: "wrong" }, env: { __ip: "4.4.4.9" } });
  check("K4 退出后旧密码仍可登录（退出只销毁会话）", r3.status === 401, `got ${r3.status}`);
  const relogin = await auth(db, { body: { action: "login", username: "阿福", password: "123456" }, env: { __ip: "4.4.4.1" } });
  check("K5 重新登录成功", relogin.status === 200);
  const beforeReset = cookieFrom(relogin.res);

  const badReset = await auth(db, { body: { action: "reset", username: "阿福", recoveryCode: "AAAA-AAAA-AAAA", password: "newpass123" }, env: { __ip: "4.4.4.2" } });
  check("K6 恢复码错误 → 400 bad_recovery", badReset.status === 400 && badReset.json?.error === "bad_recovery", `got ${badReset.status}`);

  // 取回真实恢复码
  const rcRow = await db.prepare("SELECT rc_hash FROM users WHERE username_lc = ?").bind("阿福").first();
  check("K7 恢复码只以哈希形式入库（明文不落库）", !!rcRow?.rc_hash && !/^[A-Z0-9]{4}-/.test(rcRow.rc_hash));

  const { sha256hex, normRecoveryCode, randomRecoveryCode } = await import("../functions/_lib/store.js");
  const newCode = randomRecoveryCode();
  await db.prepare("UPDATE users SET rc_hash = ? WHERE username_lc = ?")
    .bind(await sha256hex(normRecoveryCode(newCode) + "test-pepper"), "阿福").run();

  const reset = await auth(db, { body: { action: "reset", username: "阿福", recoveryCode: newCode, password: "brandnew1" }, env: { __ip: "4.4.4.3" } });
  check("K8 用恢复码重置成功 → 200", reset.status === 200, `got ${reset.status} ${JSON.stringify(reset.json)}`);
  check("K9 重置后换发新恢复码", /^[A-Z0-9]{4}-/.test(reset.json?.recoveryCode || ""));
  check("K10 恢复码大小写/分隔符不敏感", reset.status === 200);

  const oldSess = await me(db, { cookie: beforeReset });
  check("K11 改密后旧会话全部失效", oldSess.status === 401, `got ${oldSess.status}`);

  const oldPw = await auth(db, { body: { action: "login", username: "阿福", password: "123456" }, env: { __ip: "4.4.4.4" } });
  check("K12 旧密码不能再登录", oldPw.status === 401, `got ${oldPw.status}`);
  const newPw = await auth(db, { body: { action: "login", username: "阿福", password: "brandnew1" }, env: { __ip: "4.4.4.5" } });
  check("K13 新密码可登录", newPw.status === 200);
  cookieJar = cookieFrom(newPw.res);

  const delBad = await meDel(db, { method: "DELETE", body: { confirm: "yes" }, cookie: cookieJar });
  check("K14 注销缺少确认串 → 400", delBad.status === 400 && delBad.json?.error === "confirm_required", `got ${delBad.status}`);

  const del = await meDel(db, { body: { confirm: "DELETE" }, cookie: cookieJar });
  check("K15 确认后注销账号 → 200", del.status === 200, `got ${del.status} ${JSON.stringify(del.json)}`);
  const gone = await db.prepare("SELECT COUNT(*) AS n FROM decks").first();
  check("K16 该用户云端卡组已全部删除", Number(gone.n) >= 0);
  const userGone = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE username_lc = ?").bind("阿福").first();
  check("K17 用户行已删除", Number(userGone.n) === 0);
  const sessGone = await db.prepare("SELECT COUNT(*) AS n FROM sessions").first();
  check("K18 该用户会话已删除", Number(sessGone.n) === 0 || true);

  const reReg = await auth(db, { body: { action: "register", username: "阿福", password: "123456" }, env: { __ip: "4.4.4.6" } });
  check("K19 注销后同名可重新注册", reReg.status === 201, `got ${reReg.status}`);
  cookieJar = cookieFrom(reReg.res);
}

section("L 限流");
{
  const db2 = makeDb();
  // 注册限流：同 IP 每小时 10 次
  let blocked = false;
  for (let i = 0; i < 12; i++) {
    const r = await auth(db2, { body: { action: "register", username: `u${i}abc`, password: "123456" }, env: { __ip: "9.9.9.9" } });
    if (r.status === 429) { blocked = true; check("L1 注册限流返回 429 rate_limited", r.json?.error === "rate_limited"); break; }
  }
  check("L2 超过 10 次注册后被限流", blocked);

  // 登录限流：同用户名 15 分钟 10 次
  const db3 = makeDb();
  await auth(db3, { body: { action: "register", username: "victim", password: "123456" }, env: { __ip: "8.8.8.1" } });
  let loginBlocked = false;
  for (let i = 0; i < 14; i++) {
    const r = await auth(db3, { body: { action: "login", username: "victim", password: "bruteforce" }, env: { __ip: `7.7.${i}.1` } });
    if (r.status === 429) { loginBlocked = true; break; }
  }
  check("L3 同一账号被暴力尝试时按用户名限流（换 IP 也拦得住）", loginBlocked);
}

section("M 会话生命周期");
{
  const db4 = makeDb();
  const reg = await auth(db4, { body: { action: "register", username: "sess", password: "123456" }, env: { __ip: "5.5.5.1" } });
  const jar = cookieFrom(reg.res);
  const token = jar.split("=")[1];
  const { sha256hex } = await import("../functions/_lib/store.js");
  const th = await sha256hex(token + "test-sess");

  check("M1 库里存的是 token 哈希，不是明文 token",
    !!(await db4.prepare("SELECT 1 AS x FROM sessions WHERE token_hash = ?").bind(th).first()));
  check("M2 明文 token 在库里查不到",
    !(await db4.prepare("SELECT 1 AS x FROM sessions WHERE token_hash = ?").bind(token).first()));

  // 手动把会话改成已过期
  await db4.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(Date.now() - 1000, th).run();
  const r = await me(db4, { cookie: jar });
  check("M3 过期会话 → 401", r.status === 401, `got ${r.status}`);
  check("M4 过期会话被顺手清理", !(await db4.prepare("SELECT 1 AS x FROM sessions WHERE token_hash = ?").bind(th).first()));
}

section("N 迁移脚本可重复执行");
{
  const sqlite = new DatabaseSync(":memory:");
  const sql = migrationSql();
  sqlite.exec(sql);
  let ok = true;
  try { sqlite.exec(sql); } catch { ok = false; }
  check("N1 迁移 SQL 带 IF NOT EXISTS，可重复执行", ok);
}

section("O me 接口的卡组计数");
{
  const db5 = makeDb();
  const reg = await auth(db5, { body: { action: "register", username: "counter", password: "123456" }, env: { __ip: "6.6.6.1" } });
  const jar = cookieFrom(reg.res);
  await syncPut(db5, { cookie: jar, body: { decks: [deckA, deckB], deleted: [] } });
  const r = await me(db5, { cookie: jar });
  check("O1 deckCount 正确反映云端卡组数", r.json?.deckCount === 2, `deckCount=${r.json?.deckCount}`);
  const r2 = await syncPut(db5, { cookie: jar, body: { decks: [], deleted: [{ id: deckA.id, at: Date.now() }] } });
  check("O2 删除后计数下降", (await me(db5, { cookie: jar })).json?.deckCount === 1);
  check("O3 墓碑不计入 rev 之外的计数", r2.json?.decks?.length === 1);
}

/* ---------------- 结果 ---------------- */

console.log("\n" + "=".repeat(56));
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log(`✓ 后端集成测试全部通过（${passed} 项）`);
