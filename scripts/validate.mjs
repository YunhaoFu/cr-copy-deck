#!/usr/bin/env node
/**
 * 零依赖校验：push / PR 时保证 index.html 没有被改坏。
 *
 * 覆盖：
 *   A. 单文件自包含（不拆外链、不引入 <base>、不依赖 location）
 *   B. 关键 DOM / 功能钩子齐全
 *   C. 三套主题 + 默认亮色
 *   D. 卡池数据不变量（127 张 / 24 核心（6 特殊）/ 21 法术 / 4 塔防）
 *   E. 内置卡组数据不变量（120 套、无重复、形态只在合法槽位）
 *   F. 筛选名单与卡池标记一致
 *   G. 版本号存在、无敏感串
 *   H. 账号与云同步（客户端挂点 / 服务端 Functions / 路由 / 迁移）
 *
 * 用法：node scripts/validate.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "index.html");
const html = readFileSync(file, "utf8");

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { failed++; console.error(`  ✗ ${msg}`); };
const check = (cond, msg, detail) => (cond ? ok(msg) : bad(msg + (detail ? ` —— ${detail}` : "")));
const section = (t) => console.log(`\n${t}`);

/* ---------- 解析工具 ---------- */
function extractArray(name) {
  const marker = `const ${name} = [`;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`找不到 ${marker}`);
  const close = html.indexOf("];", start);              // 兼容多行数组与单行数组
  if (close < 0) throw new Error(`${name} 的结束标记 "];" 找不到`);
  const raw = html.slice(start + `const ${name} = `.length, close + 1); // 只取到 "]"
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`解析 ${name} 失败（数据必须是合法 JSON）：${e.message}`);
  }
}

let CARDS, META_DECKS, META_CORES, META_SPELLS;
try {
  CARDS = extractArray("CARDS");
  META_DECKS = extractArray("META_DECKS");
  META_CORES = extractArray("META_CORES");
  META_SPELLS = extractArray("META_SPELLS");
} catch (e) {
  console.error(`✗ 数据解析失败：${e.message}`);
  process.exit(1);
}

/* ---------- A. 单文件自包含 ---------- */
section("A. 单文件自包含");
check(!/<script[^>]+\bsrc=/i.test(html), "没有外部 <script src>");
check(!/<link[^>]+rel=["']?stylesheet/i.test(html), "没有外部样式表");
check(!/<base\b/i.test(html), "没有 <base>（否则 file:// 双击会坏）");
check(!/\b(?:src|href)=["']\.\//.test(html), "没有本地相对资源路径");
check(!/location\.(origin|href|host|hostname|pathname|search)/.test(html),
  "不使用 location.origin/href（file:// 下会算错链接）");
check(/location\.protocol !== "http:" && location\.protocol !== "https:"/.test(html),
  "只在 http(s) 下启用云同步（file:// 直接判离线）");
check(!/serviceWorker/.test(html), "没有 Service Worker（保持单文件可离线双击）");

/* ---------- B. 关键钩子 ---------- */
section("B. 关键 DOM / 功能钩子");
for (const id of ["tabs", "filterPanel", "fCores", "fSpells", "themeBtn", "copyDlg", "copyTo1v1",
                  "copyToDuel", "decks", "emptybox", "devbox", "ver", "settingsBtn", "addBtn"]) {
  check(html.includes(`id="${id}"`), `#${id} 存在`);
}
const tabOrder = [...html.matchAll(/<button class="tab" data-tab="([^"]+)"/g)].map((m) => m[1]);
check(tabOrder.join(",") === "1v1,hot1v1,duel,2v2,hot2v2",
  "标签页顺序 = 1v1 / HOT 1v1 / 决斗卡组 / 2v2 / HOT 2v2", tabOrder.join(","));

/* ---------- C. 主题 ---------- */
section("C. 主题");
const themesSrc = (html.match(/const THEMES = \[([\s\S]*?)\];/) || [, ""])[1];
check(["light", "space", "neon"].every((t) => themesSrc.includes(`"${t}"`)), "三套主题在 THEMES 中注册");
check(html.includes(':root[data-theme="light"]') && html.includes(':root[data-theme="neon"]'),
  "亮色 / 霓虹有独立变量覆盖（深空 = 基础 :root）");
check(/localStorage\.getItem\(LS_THEME\)\s*\|\|\s*"light"/.test(html), "默认主题为亮色 light");

/* ---------- D. 卡池 ---------- */
section("D. 卡池数据");
const ids = CARDS.map((c) => c.id);
check(CARDS.length === 127, "卡池 127 张", `实际 ${CARDS.length}`);
check(new Set(ids).size === CARDS.length, "卡牌 id 无重复");

const cores = CARDS.filter((c) => c.core === 1);
const specials = CARDS.filter((c) => c.core === 1 && c.special === 1);
const spells = CARDS.filter((c) => c.t === 2);
const towers = CARDS.filter((c) => c.tower === 1);
check(cores.length === 24, "核心 24 张", `实际 ${cores.length}`);
check(specials.length === 6, "特殊核心（带 ～ 标识）6 张", `实际 ${specials.length}`);
const specialSlugs = specials.map((c) => c.slug).sort().join(",");
check(specialSlugs === "goblin-barrel,goblin-drill,graveyard,miner,mortar,x-bow",
  "特殊核心 = 矿工/迫击炮/X弩/钻机/飞桶/墓园", specialSlugs);
check(spells.length === 21, "法术 21 张", `实际 ${spells.length}`);
check(towers.length === 4, "塔防（塔楼部队）4 张", `实际 ${towers.length}`);
check(cores.every((c) => c.special === 0 || c.special === 1), "核心卡的 special 标记合法");
check(!cores.some((c) => ["mega-knight", "sparky", "pekka", "giant-skeleton"].includes(c.slug)),
  "Mega Knight / Sparky / P.E.K.K.A / Giant Skeleton 未被标为核心");

/* ---------- E. 内置卡组 ---------- */
section("E. 内置卡组数据");
check(META_DECKS.length === 120, "内置卡组 120 套", `实际 ${META_DECKS.length}`);
const idSet = new Set(ids);
check(META_DECKS.every((d) => Array.isArray(d.cards) && d.cards.length === 8), "每套 8 张卡");
check(META_DECKS.every((d) => d.cards.every((c) => idSet.has(c.id))), "卡组里的卡都在卡池内");
const keys = META_DECKS.map((d) => d.cards.map((c) => c.id).sort((a, b) => a - b).join(","));
check(new Set(keys).size === META_DECKS.length, "按卡组内容无重复");
check(META_DECKS.every((d) => d.cards.every((c, i) => c.v !== "evo" || i === 0 || i === 2)),
  "觉醒只出现在第 1 / 3 格");
check(META_DECKS.every((d) => d.cards.every((c, i) => c.v !== "hero" || i === 1 || i === 2)),
  "精英只出现在第 2 / 3 格");
check(META_DECKS.every((d) => typeof d.tower === "number"), "每套都带塔防 id");
check(META_DECKS.every((d) => !/^示例/.test(d.name)), "没有示例卡组混入");

/* ---------- F. 筛选名单一致 ---------- */
section("F. 筛选名单一致性");
const coreIds = cores.map((c) => c.id).sort((a, b) => a - b);
const spellIds = spells.map((c) => c.id).sort((a, b) => a - b);
check(META_CORES.length === 24 && META_CORES.slice().sort((a, b) => a - b).join(",") === coreIds.join(","),
  "META_CORES 与卡池 core 集合一致", `${META_CORES.length} vs ${coreIds.length}`);
check(META_SPELLS.length === 21 && META_SPELLS.slice().sort((a, b) => a - b).join(",") === spellIds.join(","),
  "META_SPELLS 与卡池法术集合一致", `${META_SPELLS.length} vs ${spellIds.length}`);

/* ---------- G. 版本与敏感信息 ---------- */
section("G. 版本与敏感信息");
const ver = html.match(/const APP_VERSION = "([^"]+)"/);
check(!!ver && /^v\d/.test(ver[1]), "APP_VERSION 存在且形如 v6 · 日期", ver ? ver[1] : "缺失");
for (const pat of ["api_key", "token=", "secret", "Bearer ", "access_key"]) {
  check(!html.includes(pat), `无敏感串「${pat}」`);
}
// 现在页面里有密码输入框，所以不能在字面量上找 "password"，改为找「写死的密码值」
check(!/(^|[^_\w])password\s*:\s*["'][^"']/.test(html), "没有写死的密码值");
check(!/PASSWORD_PEPPER|SESSION_PEPPER|CR_DB/.test(html), "index.html 里不含任何服务端密钥 / 绑定名");

/* ---------- H. 账号与云同步 ---------- */
section("H. 账号与云同步");

// H1 客户端挂点：三处本地写入都必须通知同步模块
for (const [fn, kind] of [["saveDecks", "decks"], ["saveSettings", "settings"], ["applyTheme", "theme"]]) {
  const re = new RegExp(`function ${fn}\\([^)]*\\)\\{[\\s\\S]{0,1200}?notifyLocalChange\\(\"${kind}\"\\)`);
  check(re.test(html), `${fn}() 内调用 notifyLocalChange("${kind}")`);
}
check(html.includes("const SYNC = (() => {"), "SYNC 模块存在");
for (const s of ["boot", "flush", "schedule"]) {
  check(new RegExp(`\\b${s}\\b`).test(html), `SYNC 暴露 ${s}()`);
}

// H2 卡组 id / updatedAt —— 云同步的对齐键，缺了就会「删旧建新」
check(/const DECK_ID_RE = /.test(html) && /function newDeckId\(/.test(html), "卡组有客户端生成的 id");
check(/typeof d\.id === "string" && DECK_ID_RE\.test\(d\.id\)/.test(html), "normDeck 保留已有 id");
check(/const updatedAt = Number\.isFinite\(ua\)/.test(html), "normDeck 保留 / 补全 updatedAt");
check(/id: prev \? prev\.id : undefined/.test(html), "编辑已有卡组时保留原 id");

// H3 账号 / 合并弹窗的 DOM
for (const id of ["acctBtn", "acct", "acctUser", "acctPass", "acctPass2", "acctRc", "acctGo",
                  "acctForgot", "acctLogout", "acctDelete", "acctSync", "mergeDlg", "acctMsg"]) {
  check(html.includes(`id="${id}"`), `#${id} 存在`);
}
for (const kind of ["merge", "pull", "push"]) {
  check(html.includes(`data-merge="${kind}"`), `合并窗有「${kind}」选项`);
}
check(!/setTimeout\(\(\) => \$\("#acctUser"\)\.focus\(\)/.test(html),
  "没有用 setTimeout 抢焦点（会打断用户输入）");
check(html.includes('id="acctUser" autofocus'), "用户名输入框用原生 autofocus");

// H4 错误文案必须是中文
for (const t of ["用户名或密码不正确", "这个用户名已经有人用了", "密码至少 6 位", "云同步暂时不可用"]) {
  check(html.includes(t), `有中文提示「${t}」`);
}

// H5 服务端 Functions
check(existsSync(join(root, "functions/_lib/store.js")), "functions/_lib/store.js 存在");
const storeSrc = readFileSync(join(root, "functions/_lib/store.js"), "utf8");
check(/PBKDF2/.test(storeSrc), "密码用 PBKDF2 派生");
check(/HttpOnly/.test(storeSrc) && /Secure/.test(storeSrc) && /SameSite=Lax/.test(storeSrc),
  "会话 Cookie 带 HttpOnly / Secure / SameSite");
check(/max_age|Max-Age/i.test(storeSrc) || /Max-Age/.test(storeSrc), "会话 Cookie 设置了有效期");
check(/ctEqual/.test(storeSrc), "哈希比较用定长比较（防时间侧信道）");
check(!/console\.log\([^)]*password/i.test(storeSrc), "不打印密码");
for (const [f, methods] of [
  ["auth.js", ["onRequestPost"]],
  ["me.js", ["onRequestGet", "onRequestDelete"]],
  ["sync.js", ["onRequestGet", "onRequestPut"]],
]) {
  const src = readFileSync(join(root, "functions/api", f), "utf8");
  for (const m of methods) check(src.includes(`export async function ${m}`), `api/${f} 导出 ${m}`);
  check(/storage_not_configured/.test(src) || /notConfigured\(/.test(src),
    `api/${f} 在 D1 未绑定时优雅降级`);
}
const syncSrc = readFileSync(join(root, "functions/api/sync.js"), "utf8");
check(/deleted_at/.test(syncSrc), "同步用墓碑记录删除");
check(/ON CONFLICT/.test(syncSrc), "写入用 upsert（幂等）");
check(/MAX_DECKS/.test(syncSrc), "服务端限制单用户卡组数量");

// H6 路由与迁移
const routes = JSON.parse(readFileSync(join(root, "_routes.json"), "utf8"));
check(routes.version === 1 && JSON.stringify(routes.include) === '["/api/*"]' && routes.exclude.length === 0,
  "_routes.json 只把 /api/* 交给 Functions");
const sql = readFileSync(join(root, "migrations/0001_sync_auth.sql"), "utf8");
for (const t of ["users", "sessions", "decks", "user_settings", "auth_limits"]) {
  check(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`).test(sql), `迁移建表 ${t}`);
}
check(/CREATE TABLE IF NOT EXISTS/.test(sql) && (sql.match(/CREATE TABLE IF NOT EXISTS/g) || []).length ===
  (sql.match(/CREATE TABLE/g) || []).length, "迁移可重复执行（全部 IF NOT EXISTS）");
check(!/email/i.test(sql), "不收集邮箱等个人信息（只用用户名 + 密码）");

/* ---------- 汇总 ---------- */
console.log(`\n${failed === 0 ? "✅ 全部校验通过" : `❌ ${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);
