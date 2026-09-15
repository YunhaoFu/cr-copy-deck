#!/usr/bin/env node
/**
 * 生成「HOT 决斗」的内置 4 套组合数据（META_DUELS）。
 *
 * 数据源：https://royaletracker.gg/best-decks/clan-war
 *   部落战决斗的规则是「一次带 4 套、4 套之间卡不能重复」，RoyaleTracker 这一页
 *   正好按这个单位给出组合（combinations），每个组合 4 套，按真实对战胜率排序，
 *   并且带 isEvolved / isHero 标记。
 *
 * 为什么要脚本而不是手抄：
 *   1. 记录数据出处与换算规则，将来数据更新能重跑；
 *   2. 卡牌顺序必须重排 —— 数据源给的顺序不满足本应用的槽位规则
 *      （觉醒只能放第 1/3 格、精英只能放第 2/3 格，见 README「卡牌分类与形态」）；
 *   3. 顺手做一遍完整性校验，避免把不合法数据写进 index.html。
 *
 * 用法：
 *   node scripts/gen-duels.mjs            # 打印 JS 数组，人工粘进 index.html
 *   node scripts/gen-duels.mjs --check    # 只校验不打印（用于 CI）
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "https://royaletracker.gg/best-decks/clan-war";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CHECK_ONLY = process.argv.includes("--check");

/* ---------- 1. 抓取 ---------- */
const res = await fetch(SOURCE, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" } });
if (!res.ok) {
  console.error(`× 抓取失败 ${res.status} ${res.statusText}：${SOURCE}`);
  process.exit(1);
}
const html = await res.text();

/* ---------- 2. 从 Next.js flight 数据里抠出 combinations ---------- */
// 页面把数据切成若干段 self.__next_f.push([1,"..."])，先拼回完整字符串
const parts = [...html.matchAll(/self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g)].map(m => {
  try { return JSON.parse(m[1]); } catch { return ""; }
});
const buf = parts.join("");
const at = buf.indexOf('{"combinations":[');
if (at < 0) {
  console.error("× 页面里找不到 combinations 数据（数据源改版了？）");
  process.exit(1);
}
let depth = 0, end = -1;
for (let i = at; i < buf.length; i++) {
  if (buf[i] === "{") depth++;
  else if (buf[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
const data = JSON.parse(buf.slice(at, end));
console.log(`数据源 ${SOURCE}`);
console.log(`  解析到 ${data.combinations.length} 个组合、${data.combinations.reduce((n, c) => n + c.decks.length, 0)} 套卡组`);

/* ---------- 3. 本应用的卡池（用于校验，不依赖网络） ---------- */
const siteHtml = readFileSync(join(root, "index.html"), "utf8");
const ci = siteHtml.indexOf("const CARDS = [");
const cardPool = new Set(JSON.parse(siteHtml.slice(siteHtml.indexOf("[", ci), siteHtml.indexOf("];", ci) + 1)).map(c => c.id));
const DEFAULT_TOWER = 159000000;   // 数据源不给塔防，统一用公主塔

/* ---------- 4. 按槽位规则重排 8 张卡 ---------- */
// 默认规则：第 1 格只放觉醒、第 2 格放精英、第 3 格万能、4–8 格只放普通。
// 所以先把觉醒/精英安置到合法格子，其余按原顺序填空位。
function arrange(cards) {
  const evo = cards.filter(c => c.isEvolved);
  const hero = cards.filter(c => c.isHero && c.rarity !== "champion");
  const rest = cards.filter(c => !evo.includes(c) && !hero.includes(c));
  const slots = new Array(8).fill(null);
  if (evo[0]) slots[0] = evo[0];                 // 第 1 格：觉醒
  if (hero[0]) slots[1] = hero[0];               // 第 2 格：精英
  const third = evo[1] || hero[1];               // 第 3 格：万能，优先第二个觉醒
  if (third) slots[2] = third;
  let ri = 0;
  for (let i = 0; i < 8; i++) if (!slots[i] && ri < rest.length) slots[i] = rest[ri++];
  return slots;
}

/* ---------- 5. 转换 + 校验 ---------- */
const problems = [];
const out = [];
const seenCombo = new Set();

for (const c of data.combinations) {
  if (c.decks.length !== 4) { problems.push(`组合 #${c.rank} 不是 4 套（${c.decks.length}）`); continue; }
  const decks = [];
  const usedIds = new Set();

  for (const dk of c.decks) {
    if (dk.cards.length !== 8) { problems.push(`${dk.name} 不是 8 张卡`); continue; }
    for (const cd of dk.cards) {
      if (!cardPool.has(cd.id)) problems.push(`${dk.name} 的「${cd.name}」(${cd.id}) 不在本应用卡池里`);
      if (usedIds.has(cd.id)) problems.push(`组合 #${c.rank} 内卡牌重复：${cd.name}`);
      usedIds.add(cd.id);
    }
    const slots = arrange(dk.cards);
    if (slots.some(s => !s)) { problems.push(`${dk.name} 重排后还有空位`); continue; }
    decks.push({
      name: dk.name,
      win: dk.winRate,
      tower: DEFAULT_TOWER,
      cards: slots.map(cd => ({ id: cd.id, v: cd.isEvolved ? "evo" : (cd.isHero && cd.rarity !== "champion") ? "hero" : "" })),
    });
  }

  // 重排后必须仍然满足槽位规则
  for (const dk of decks) {
    dk.cards.forEach((c2, i) => {
      if (c2.v === "evo" && i !== 0 && i !== 2) problems.push(`#${c.rank} ${dk.name}：觉醒落在第 ${i + 1} 格`);
      if (c2.v === "hero" && i !== 1 && i !== 2) problems.push(`#${c.rank} ${dk.name}：精英落在第 ${i + 1} 格`);
    });
  }

  const key = decks.map(d => d.cards.map(x => x.id).join(",")).join("|");
  if (seenCombo.has(key)) problems.push(`组合 #${c.rank} 与前面某组内容完全相同`);
  seenCombo.add(key);

  out.push({ rank: c.rank, win: c.wilsonScore, decks });
}

if (problems.length) {
  console.error(`\n× 校验未通过（${problems.length} 条）：`);
  for (const p of problems.slice(0, 20)) console.error("   " + p);
  process.exit(1);
}
console.log(`  校验通过：每组 4 套、每套 8 张、组内卡不重复、卡都在卡池内、形态落在合法槽位`);

if (!CHECK_ONLY) {
  console.log(`\n把下面这段替换 index.html 里的 const META_DUELS = [...];\n`);
  console.log("const META_DUELS = " + JSON.stringify(out) + ";");
}
