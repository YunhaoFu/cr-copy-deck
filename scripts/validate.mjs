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
 *
 * 用法：node scripts/validate.mjs
 */
import { readFileSync } from "node:fs";
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
check(!/(^|[^.\w])location\./.test(html), "不依赖 location（无 origin/协议分支）");
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
for (const pat of ["api_key", "token=", "secret", "Bearer ", "password", "access_key"]) {
  check(!html.includes(pat), `无敏感串「${pat}」`);
}

/* ---------- 汇总 ---------- */
console.log(`\n${failed === 0 ? "✅ 全部校验通过" : `❌ ${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);
