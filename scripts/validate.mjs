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

/* ---------- I. 安全加固 ---------- */
section("I. 安全加固");

// I1 构建产物里的安全文件
for (const f of ["_headers", "404.html", "robots.txt"]) {
  check(existsSync(join(root, f)), `${f} 存在于仓库根`);
}
const buildSrc = readFileSync(join(root, "scripts/build-site.mjs"), "utf8");
for (const f of ["_headers", "404.html", "robots.txt"]) {
  check(buildSrc.includes(`"${f}"`), `构建脚本会把 ${f} 拷进 dist/`);
}

// I2 _headers 内容
const headersSrc = readFileSync(join(root, "_headers"), "utf8");
for (const h of ["X-Content-Type-Options: nosniff", "X-Frame-Options: DENY", "Referrer-Policy: no-referrer",
                 "Strict-Transport-Security:", "Permissions-Policy:", "X-Robots-Tag: noindex"]) {
  check(headersSrc.includes(h), `_headers 含 ${h.split(":")[0]}`);
}
for (const d of ["frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'"]) {
  check(headersSrc.includes(d), `CSP 含「${d}」`);
}
// 只看真正的 CSP 响应头那一行，别被注释里的说明文字误伤
const cspLine = (headersSrc.match(/^\s*Content-Security-Policy:(.*)$/m) || [, ""])[1];
check(!!cspLine, "_headers 里有 Content-Security-Policy 响应头");
check(!/default-src/.test(cspLine), "CSP 不写 default-src（本页必须内联脚本，写了就得靠 unsafe-inline）");
check(!/unsafe-inline/.test(cspLine), "CSP 里没有 unsafe-inline");
check(!headersSrc.split("\n").some(l => /^\s+#/.test(l)), "_headers 没有缩进的注释行（会被当成响应头名解析）");
check(/^\/\*/m.test(headersSrc), '_headers 有 "/*" 规则块');

// I3 robots.txt
const robotsSrc = readFileSync(join(root, "robots.txt"), "utf8");
check(/^Disallow:\s*\/\s*$/m.test(robotsSrc), "robots.txt 禁止收录");
check(!/^Allow:/im.test(robotsSrc), "robots.txt 没有放行规则");

// I4 404 页
const notFoundSrc = readFileSync(join(root, "404.html"), "utf8");
check(!/<script/i.test(notFoundSrc), "404 页不含脚本（纯静态，不引入反射面）");
check(!/\bsrc\s*=/i.test(notFoundSrc), "404 页不加载外部资源");
check(notFoundSrc.length < 8192, "404 页足够小（未匹配路径不再返回 190KB 首页）", notFoundSrc.length + " 字节");

// I5 后端 fail-closed 行为（storeSrc / syncSrc 已在 H 节读过）
check(/typeof v === "string" && DECK_ID_RE\.test\(v\)/.test(storeSrc), "validDeckId 严格判字符串（数组不能蒙混过关）");
check(/Number\.isFinite\(ua\)[\s\S]{0,140}?: 0;/.test(storeSrc), "sanitizeDeck 非法 updatedAt 回退 0（fail-closed）");
check(/request\.body\.getReader\(\)/.test(storeSrc), "readBody 流式读取，不是先读满再判长度");
check(/total > MAX_BODY/.test(storeSrc), "readBody 按字节累计，超限即断");
check(/reader\.cancel\(\)/.test(storeSrc), "readBody 超限时主动取消流");
for (const fn of ["rateLimitPeek", "rateLimitHit", "clearBucket", "cleanupSessions", "userBucketKey"]) {
  check(new RegExp(`export async function ${fn}\\(`).test(storeSrc), `store.js 导出 ${fn}()`);
}
check(/nosniff/.test(storeSrc) && /referrer-policy/.test(storeSrc), "Functions 的 JSON 响应也带 nosniff / referrer-policy");

const authSrc = readFileSync(join(root, "functions/api/auth.js"), "utf8");
check(/validUsername\(username\) \|\| !validPassword\(password\)/.test(authSrc), "登录先校验用户名与密码形状（超长名字不会建桶）");
check(/userBucketKey\(context\.env, "login:u:"/.test(authSrc), "登录限流桶键走哈希，不存用户名明文");
check(/await rateLimitHit\(db, bucket, LOGIN_WINDOW\)/.test(authSrc), "只有登录失败才计数");
check(/await clearBucket\(db, bucket\)/.test(authSrc), "登录成功把失败计数清零");
check(!/const password = String\(data\.password/.test(authSrc), "密码不再先 String(...) 再校验");
check(/unique\|constraint/.test(authSrc), "注册只把 UNIQUE 冲突当重名，其它异常照常抛");
check(/cleanupSessions/.test(authSrc), "登录时清理该用户的过期会话");

check(/MAX_SKEW_MS\) : 0;/.test(syncSrc), "sync 的设置/主题时间戳非法回退 0");
check(/!Number\.isFinite\(at\)\) return fail\("invalid_deck", 400\)/.test(syncSrc), "墓碑时间戳非法直接 400（不默认成 now）");

// I6 前端纵深防御：卡牌 id 不能裸插进 HTML
check(!html.includes('title="未知卡牌 #${id}"'), "卡牌缩略图不再裸插 id");
check(html.includes("escapeHtml(String(id))"), "卡牌缩略图的 id 已转义");
check(html.includes("escapeHtml(String(c.id))"), "卡组详情里的卡牌 id 已转义");

/* ---------- J. UI 细节（亮色可读性 / 移动端 / 按钮语义） ---------- */
section("J. UI 细节");

// J1 亮色主题下星标必须保留形态颜色。
// 曾经的 bug：.star 被并进「统一 background:#fff;color:#33406b」那组选择器里，
// 而 :root[data-theme="light"] .star 的权重高于 .star.purple，于是紫/橙/银全被压成同一种深蓝。
check(!/:root\[data-theme="light"\] \.star,/.test(html), "星标没有被并进「统一配色」那组选择器");
for (const [cls, label] of [["silver", "普通"], ["purple", "觉醒"], ["orange", "精英"]]) {
  const m = html.match(new RegExp(`:root\\[data-theme="light"\\] \\.star\\.${cls}\\{color:([^}]+)\\}`));
  check(!!m, `亮色主题下 .star.${cls}（${label}）有独立颜色定义`, m ? m[1] : "未定义");
}
const lightStarColors = ["silver", "purple", "orange"].map(c => {
  const m = html.match(new RegExp(`:root\\[data-theme="light"\\] \\.star\\.${c}\\{color:([^}]+)\\}`));
  return m ? m[1].trim() : "";
});
check(new Set(lightStarColors).size === 3, "亮色主题下三种形态的星标颜色互不相同", lightStarColors.join(" / "));

// J2 窄屏布局
const mobileIdx = html.indexOf("@media (max-width:620px)");
const mobileCss = mobileIdx < 0 ? "" : html.slice(mobileIdx, html.indexOf("</style>", mobileIdx));
check(!!mobileCss, "存在窄屏媒体查询");
check(/\.selrow\{grid-template-columns:repeat\(4,1fr\)/.test(mobileCss),
  "窄屏下 8 格选卡按等分列（原来写死 4×84px，第四格会被裁掉）");
check(/\.towerslot\{width:100%;display:flex/.test(mobileCss),
  "窄屏下塔防槽改横排（否则里面的卡图被撑到铺满整屏）");
check(/\.towerslot \.t\{[^}]*width:68px/.test(mobileCss), "窄屏下塔防卡图有固定宽度");

// J3 卡组卡片按钮语义
const dchIdx = html.indexOf("function deckCardHtml");
const dch = dchIdx < 0 ? "" : html.slice(dchIdx, dchIdx + 1600);
check(/\? `<button class="opbtn view"/.test(dch), "自己的卡组第一个按钮是「查看」");
check(/\n?\s*: `<button class="opbtn copy"/.test(dch), "HOT 卡组保留「复制」");
check(!/<div class="ops">\s*<button class="opbtn copy"/.test(dch), "自己的卡组不再有无条件的「复制」按钮");
check(/btn\.classList\.contains\("view"\)\)\{ openDetail\(deck\)/.test(html), "「查看」按钮绑定到 openDetail()");

/* ---------- 汇总 ---------- */
console.log(`\n${failed === 0 ? "✅ 全部校验通过" : `❌ ${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);
