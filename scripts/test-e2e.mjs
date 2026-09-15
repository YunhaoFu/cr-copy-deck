#!/usr/bin/env node
/**
 * 浏览器端到端测试：真开一个 Chrome，跑「注册 → 建卡组 → 换设备登录 → 双向同步 → 删除 → 离线降级」全流程。
 *
 * 依赖 puppeteer-core（不进 package.json，按需自备）：
 *   npm i -D puppeteer-core@23        或   NODE_PATH=/path/to/node_modules node scripts/test-e2e.mjs
 * 需要本机有 Chrome；可用 CHROME_PATH 指定。
 *
 * 用法：node scripts/test-e2e.mjs [--keep]   （--keep 时保留浏览器与服务器，方便手工看）
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
// 设了 E2E_BASE 就跑远端（如 https://cr-copy-deck.pages.dev/），否则自己拉一个本地开发服务器
const REMOTE = (process.env.E2E_BASE || "").trim();
const BASE = REMOTE ? (REMOTE.endsWith("/") ? REMOTE : REMOTE + "/") : `http://localhost:${PORT}/`;
const KEEP = process.argv.includes("--keep");

/* ---------------- 加载 puppeteer-core（可为全局安装） ---------------- */
async function loadPuppeteer() {
  const require = createRequire(import.meta.url);
  const candidates = ["puppeteer-core", process.env.PUPPETEER_PATH].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch {}
  }
  console.error("× 找不到 puppeteer-core。请先 `npm i -D puppeteer-core@23`，或用 NODE_PATH 指向已装好的目录。");
  process.exit(2);
}

const puppeteer = await loadPuppeteer();
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";

/* ---------------- 断言 ---------------- */
let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); return true; }
  failures.push(name + (extra ? `  → ${extra}` : ""));
  console.log("  ✗ " + name + (extra ? `  → ${extra}` : ""));
  return false;
}
const section = t => console.log(`\n── ${t} ──`);

/* ---------------- 开发服务器（跑远端时不需要） ---------------- */
const server = REMOTE ? null : spawn(process.execPath, [join(root, "scripts/dev-server.mjs"), "--port", String(PORT)], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"],
});
if (server) {
  server.stderr.on("data", d => {
    const s = String(d);
    if (!/ExperimentalWarning|trace-warnings/.test(s)) process.stderr.write("[server] " + s);
  });
}

function cleanup() {
  try { server && server.kill("SIGKILL"); } catch {}
}

/* ---------------- 浏览器 ---------------- */
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

/** 新建一台"设备"：独立 Cookie + 独立 localStorage */
async function newDevice(label) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1360, height: 950 });
  const errors = [];
  const net = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("response", async r => {
    if (!r.url().includes("/api/")) return;
    const body = await r.text().catch(() => "");
    net.push(`${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()} ${body.slice(0, 90)}`);
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof SYNC !== "undefined", { timeout: 15000 });
  return { label, context, page, errors, net };
}

const phase = page => page.evaluate(() => SYNC.phase());
const deckNames = page => page.evaluate(() => decks.map(d => d.name));
const cloud = page => page.evaluate(async () => {
  const r = await fetch("api/sync", { credentials: "same-origin" });
  return r.ok ? await r.json() : null;
});

// 跑线上时一次 HTTPS 往返要 5–7 秒（本机走代理），超时按环境放宽
const T_SYNC = REMOTE ? 60000 : 15000;     // 等一次同步落库
const T_SOON = REMOTE ? 45000 : 12000;     // 等页面状态最终一致

async function waitCloud(page, pred, what, timeout = T_SYNC) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await cloud(page).catch(() => null);
    if (last && last.ok && pred(last)) return last;
    await sleep(250);
  }
  throw new Error(`等待云端「${what}」超时：${JSON.stringify(last && { decks: last.decks && last.decks.map(d => d.name), theme: last.theme })}`);
}

/** 填账号表单，并把实际填进去的值回读出来——防止"输入被打断"这类竞态悄悄溜过 */
async function fillAcct(page, { user, pass, pass2 }) {
  await page.type("#acctUser", user);
  await page.type("#acctPass", pass);
  if (pass2 !== undefined && pass2 !== null) await page.type("#acctPass2", pass2);
  return page.evaluate(() => ({
    u: document.querySelector("#acctUser").value,
    p: document.querySelector("#acctPass").value,
    p2: document.querySelector("#acctPass2").value,
  }));
}

/** 等页面里的某个条件最终成立（云同步是异步的，不能立刻断言） */
async function checkSoon(page, fn, name, timeout = T_SOON) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn).catch(() => false)) return check(name, true);
    await sleep(200);
  }
  const got = await page.evaluate(fn).catch(e => "ERR " + e.message);
  return check(name, false, "超时，当前值 " + JSON.stringify(got));
}

/** 等账号弹窗里出现某段文案（用于"等一次请求失败"这类没有正向信号的场景） */
async function waitMsg(page, needle, timeout = REMOTE ? 40000 : 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const t = await page.$eval("#acctMsg", e => e.textContent).catch(() => "");
    if (t.includes(needle)) return t;
    await sleep(200);
  }
  return "";
}

/* ---------------- 流程 ---------------- */

async function waitForServer() {
  for (let i = 0; i < (REMOTE ? 20 : 60); i++) {
    try {
      const r = await fetch(BASE + "api/me");
      if (r.status === 401 || r.status === 200 || r.status === 503) return;
    } catch {}
    await sleep(300);
  }
  throw new Error("目标站点没有响应：" + BASE);
}
await waitForServer();
console.log((REMOTE ? "跑远端站点：" : "开发服务器已就绪：") + BASE);

// 跑远端时用一次性用户名，别和真实用户撞名
const USER = REMOTE ? "e2e-" + Date.now().toString(36) : "队长阿福";
const PASS = "123456";
let recoveryCode = "";
let deckId = "";
const A = await newDevice("设备A");
const B = await newDevice("设备B");

try {
  section("1 初始状态（未登录，纯本地）");
  check("1.1 未登录时 phase = anon", await phase(A.page) === "anon");
  check("1.2 账号按钮显示「登录」", (await A.page.$eval("#acctBtn .who", e => e.textContent)).trim() === "登录");
  check("1.3 无需登录即可看到内置 HOT 卡组", await A.page.evaluate(() => META_DECKS.length) === 120);
  await A.page.evaluate(() => { activeTab = "hot1v1"; render(); });
  await sleep(400);
  check("1.4 HOT 页正常渲染出卡组卡片", await A.page.evaluate(() => document.querySelectorAll("#decks .deck").length) > 0);
  const hotBtns = await A.page.evaluate(() =>
    [...new Set([...document.querySelectorAll("#decks .deck .opbtn")].map(b => b.textContent.trim()))]);
  check("1.5 HOT 卡组只有「复制」按钮", hotBtns.join(",") === "复制", JSON.stringify(hotBtns));

  section("2 注册");
  await A.page.click("#acctBtn");
  await A.page.waitForSelector("#acct[open]", { timeout: 5000 });
  await A.page.click("#tabReg");
  const formA = await fillAcct(A.page, { user: USER, pass: PASS, pass2: PASS });
  check("2.0 注册表单内容与预期一致（输入没有被抢焦点打断）",
    formA.u === USER && formA.p === PASS && formA.p2 === PASS, JSON.stringify(formA));
  await A.page.click("#acctGo");
  const gotRc = await A.page.waitForSelector("#acctMsg .rcbox", { timeout: 20000 }).then(() => true).catch(() => false);
  check("2.1 注册后弹出恢复码（只显示一次）", gotRc);
  recoveryCode = gotRc ? (await A.page.$eval("#acctMsg .rcbox", e => e.textContent.trim())) : "";
  check("2.2 恢复码格式正确", /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(recoveryCode), recoveryCode);
  await A.page.click('#acct .close');
  check("2.3 注册后 phase = on", await phase(A.page) === "on");
  check("2.4 账号按钮显示用户名", (await A.page.$eval("#acctBtn .who", e => e.textContent)).trim() === USER);

  section("3 建卡组 → 自动同步到云端");
  await A.page.evaluate(() => { activeTab = "1v1"; render(); });
  await A.page.click("#addBtn");
  await A.page.waitForSelector("#editor[open]", { timeout: 5000 });
  await A.page.type("#eName", "2.6 猪");
  const picks = [26000014, 26000038, 27000000, 26000010, 26000030, 28000011, 26000021, 28000000];
  for (const id of picks) {
    await A.page.click(`#eGrid .c[data-id="${id}"]`);
  }
  // 亮色主题下三个形态的星标必须能区分开（曾经被一条高权重的亮色覆盖全压成同一种深蓝）
  const starColors = await A.page.evaluate(() =>
    [...new Set([...document.querySelectorAll("#eSel .star")].map(el => getComputedStyle(el).color))]);
  check("3.0 亮色主题下星标颜色可区分（≥3 种）", starColors.length >= 3, JSON.stringify(starColors));

  await A.page.click("#eSave");
  await A.page.waitForFunction(() => !document.querySelector("#editor").open, { timeout: 5000 });
  await sleep(300);
  const myBtns = await A.page.evaluate(() =>
    [...document.querySelectorAll("#decks .deck .opbtn")].map(b => b.textContent.trim()));
  check("3.5 自己的卡组按钮 = 查看 / 编辑 / 删除（不再有复制）",
    myBtns.join(",") === "查看,编辑,删除", JSON.stringify(myBtns));
  const local = await A.page.evaluate(() => decks.map(d => ({ id: d.id, name: d.name, n: d.cards.length })));
  check("3.1 本地已新增 1 套卡组", local.length === 1 && local[0].n === 8, JSON.stringify(local));
  deckId = local[0] && local[0].id;
  check("3.2 卡组带上了 id（同步的对齐键）", /^[a-z0-9]{8,24}$/.test(deckId || ""), String(deckId));
  await waitCloud(A.page, c => c.decks.length === 1, "出现 1 套卡组");
  const c1 = await cloud(A.page);
  check("3.3 云端已收到这套卡组", c1.decks.length === 1 && c1.decks[0].id === deckId);
  check("3.4 云端卡组内容完整（8 张卡 + 塔防）", c1.decks[0].cards.length === 8 && c1.decks[0].tower === 159000000);

  section("4 换设备登录 → 看到同一份数据");
  check("4.1 设备B 独立（未登录、无卡组）",
    await phase(B.page) === "anon" && (await deckNames(B.page)).length === 0);
  await B.page.click("#acctBtn");
  await B.page.waitForSelector("#acct[open]", { timeout: 5000 });
  const formB = await fillAcct(B.page, { user: USER, pass: PASS });
  check("4.1b 登录表单内容与预期一致", formB.u === USER && formB.p === PASS, JSON.stringify(formB));
  await B.page.click("#acctGo");
  await B.page.waitForFunction(() => SYNC.phase() === "on", { timeout: 20000 });
  // 不能用固定 sleep 断言：登录成功只代表拿到会话，首次拉取还在路上。
  // 跑线上时一次请求要好几秒（走代理），等条件成立才靠谱。
  await checkSoon(B.page, () => decks.length === 1 && decks[0].name === "2.6 猪", "4.2 设备B 登录后自动拉到云端的卡组");
  const onB = await B.page.evaluate(() => decks.map(d => ({ name: d.name, n: d.cards.length, tower: d.tower })));
  check("4.3 拉下来的卡组内容完整（8 张卡 + 塔防）",
    onB[0]?.n === 8 && onB[0]?.tower === 159000000, JSON.stringify(onB));

  section("5 设备B 改名 → 设备A 收到（且不会变成两套）");
  await B.page.evaluate(() => { activeTab = "1v1"; render(); });
  await B.page.waitForSelector("#decks .deck .opbtn", { timeout: 5000 });
  await B.page.evaluate(() => {
    const d = decks[0];
    decks[0] = normDeck({ ...d, name: "2.6 猪（改名）", updatedAt: Date.now() });
    saveDecks(decks); render();
  });
  await waitCloud(B.page, c => c.decks.length === 1 && c.decks[0].name.includes("改名"), "改名生效");
  const c5 = await cloud(B.page);
  check("5.1 改名后云端仍是 1 套（id 被保留，没有变成删旧建新）", c5.decks.length === 1, JSON.stringify(c5.decks.map(d => d.name)));
  check("5.2 云端名字已更新", c5.decks[0].name === "2.6 猪（改名）", c5.decks[0].name);
  check("5.3 云端卡组 id 没变", c5.decks[0].id === deckId, c5.decks[0].id);

  await A.page.reload({ waitUntil: "domcontentloaded" });
  await A.page.waitForFunction(() => typeof SYNC !== "undefined", { timeout: 15000 });
  await A.page.waitForFunction(() => SYNC.phase() === "on", { timeout: 20000 });
  await checkSoon(A.page, () => decks.some(d => d.name.includes("改名")), "5.4 设备A 刷新后看到改名");
  check("5.5 设备A 仍只有 1 套卡组", (await deckNames(A.page)).length === 1, JSON.stringify(await deckNames(A.page)));

  section("6 主题跨设备同步");
  await B.page.evaluate(() => { curTheme = "neon"; applyTheme("neon"); });
  await waitCloud(B.page, c => c.theme === "neon", "主题变成 neon");
  await A.page.reload({ waitUntil: "domcontentloaded" });
  await A.page.waitForFunction(() => typeof SYNC !== "undefined", { timeout: 15000 });
  await A.page.waitForFunction(() => SYNC.phase() === "on", { timeout: 20000 });
  await checkSoon(A.page, () => document.documentElement.getAttribute("data-theme") === "neon", "6.1 设备A 刷新后主题同步为 neon");

  section("7 设置跨设备同步");
  await B.page.evaluate(() => {
    settings = { ...settings, label: "SyncTest" };
    saveSettings(settings);
  });
  await waitCloud(B.page, c => c.settings && c.settings.label === "SyncTest", "设置同步");
  await A.page.reload({ waitUntil: "domcontentloaded" });
  await A.page.waitForFunction(() => typeof SYNC !== "undefined", { timeout: 15000 });
  await A.page.waitForFunction(() => SYNC.phase() === "on", { timeout: 20000 });
  await checkSoon(A.page, () => settings.label === "SyncTest", "7.1 设备A 刷新后设置同步");

  section("8 删除跨设备同步（墓碑，不会被旧数据复活）");
  await A.page.evaluate(() => { decks = []; saveDecks(decks); render(); });
  await waitCloud(A.page, c => c.decks.length === 0 && c.tombstones.length >= 1, "删除生效");
  const c8 = await cloud(A.page);
  check("8.1 云端卡组已空", c8.decks.length === 0);
  check("8.2 云端留下墓碑", c8.tombstones.some(t => t.id === deckId), JSON.stringify(c8.tombstones));
  // 先记下 B 当前已同步到的时间点，刷新后等它前进 —— 否则"列表为空"在拉取完成前就已经成立了，
  // 断言会变成假阳性
  const beforeSync = await B.page.evaluate(() => SYNC._state().lastSyncAt);
  await B.page.evaluate(v => { window.__beforeSync = v; }, beforeSync);
  await B.page.reload({ waitUntil: "domcontentloaded" });
  await B.page.waitForFunction(() => typeof SYNC !== "undefined", { timeout: 15000 });
  await B.page.waitForFunction(() => SYNC.phase() === "on", { timeout: 20000 });
  await checkSoon(B.page, () => SYNC._state().lastSyncAt > (window.__beforeSync || 0), "8.3a 设备B 刷新后完成一次拉取");
  check("8.3 设备B 刷新后卡组也被删掉（没有被本地旧数据复活）",
    (await deckNames(B.page)).length === 0, JSON.stringify(await deckNames(B.page)));

  section("8.5 首次登录且两边都有卡组 → 弹合并窗（只问这一次）");
  // 先让云端重新有一套卡组
  await A.page.evaluate(() => {
    decks = [normDeck({ name: "云端已有", cards: META_DECKS[0].cards.map(c => ({ id: c.id, v: c.v })), tower: 159000000, updatedAt: Date.now() })];
    saveDecks(decks); render();
  });
  await waitCloud(A.page, c => c.decks.length === 1 && c.decks[0].name === "云端已有", "云端重新有 1 套");

  const E = await newDevice("设备E");
  await E.page.evaluate(() => {
    decks.push(normDeck({ name: "本地独有", cards: META_DECKS[1].cards.map(c => ({ id: c.id, v: c.v })), tower: 159000000, updatedAt: Date.now() }));
    saveDecks(decks); render();
  });
  check("8.5.1 设备E 登录前本地有 1 套卡组", (await deckNames(E.page)).length === 1);
  await E.page.click("#acctBtn");
  await E.page.waitForSelector("#acct[open]", { timeout: 5000 });
  await fillAcct(E.page, { user: USER, pass: PASS });
  await E.page.click("#acctGo");
  const mergeShown = await E.page.waitForSelector("#mergeDlg[open]", { timeout: 20000 }).then(() => true).catch(() => false);
  check("8.5.2 两边都有卡组时弹出合并窗", mergeShown);
  if (mergeShown) {
    const txt = await E.page.$eval("#mergeMsg", e => e.textContent);
    check("8.5.3 合并窗提示了两边的数量", /本机有/.test(txt) && /云端账号有/.test(txt), txt.replace(/\s+/g, " "));
    await E.page.click('#mergeDlg [data-merge="merge"]');
  }
  await waitCloud(E.page, c => c.decks.length === 2, "合并后云端有 2 套");
  const c85 = await cloud(E.page);
  const names85 = c85.decks.map(d => d.name).sort();
  check("8.5.4 合并后云端两套都在", names85.length === 2 && names85.includes("云端已有") && names85.includes("本地独有"), JSON.stringify(names85));
  check("8.5.5 设备E 本地也拿到两套", (await deckNames(E.page)).length === 2, JSON.stringify(await deckNames(E.page)));

  // 收尾：把云端清空，避免影响后续断言
  await E.page.evaluate(() => { decks = []; saveDecks(decks); render(); });
  await waitCloud(E.page, c => c.decks.length === 0, "清空云端");
  await E.page.click('#acct .close').catch(() => {});
  await E.context.close();

  section("9 退出 / 重新登录");
  await A.page.click("#acctBtn");
  await A.page.waitForSelector("#acct[open]", { timeout: 5000 });
  const stats = await A.page.$eval("#acctStats", e => e.textContent);
  check("9.1 账号面板显示云端卡组数", /云端卡组/.test(stats), stats.replace(/\s+/g, " ").trim());
  await A.page.click("#acctLogout");
  await A.page.waitForFunction(() => SYNC.phase() === "anon", { timeout: 10000 });
  check("9.2 退出后 phase = anon", await phase(A.page) === "anon");
  await fillAcct(A.page, { user: USER, pass: PASS });
  await A.page.click("#acctGo");
  await A.page.waitForFunction(() => SYNC.phase() === "on", { timeout: 20000 });
  check("9.3 重新登录成功", await phase(A.page) === "on");
  await A.page.click('#acct .close');

  section("10 用恢复码重置密码");
  const C = await newDevice("设备C");
  await C.page.click("#acctBtn");
  await C.page.waitForSelector("#acct[open]", { timeout: 5000 });
  await C.page.click("#acctForgot");
  await fillAcct(C.page, { user: USER, pass: "newpass123" });
  await C.page.type("#acctRc", recoveryCode);
  await C.page.click("#acctGo");
  await C.page.waitForFunction(() => SYNC.phase() === "on", { timeout: 20000 });
  check("10.1 用恢复码重置并自动登录", await phase(C.page) === "on");
  const newRc = await C.page.$eval("#acctMsg .rcbox", e => e.textContent.trim()).catch(() => "");
  check("10.2 重置后换发新恢复码", /^[A-Z0-9]{4}-/.test(newRc) && newRc !== recoveryCode, newRc);
  await C.page.click('#acct .close');
  const D = await newDevice("设备D");
  await D.page.click("#acctBtn");
  await D.page.waitForSelector("#acct[open]", { timeout: 5000 });
  await fillAcct(D.page, { user: USER, pass: PASS });
  await D.page.click("#acctGo");
  const oldPwMsg = await waitMsg(D.page, "不正确");
  check("10.3 旧密码已失效", oldPwMsg.includes("不正确"), oldPwMsg || "等不到错误提示");

  section("11 错误提示 / 用新密码登录");
  await D.page.evaluate(() => { document.querySelector("#acctPass").value = "stillwrong"; });
  await D.page.click("#acctGo");
  const errMsg = await waitMsg(D.page, "不正确");
  check("11.1 密码错误时给出中文提示", errMsg.includes("不正确"), errMsg || "等不到错误提示");
  check("11.2 密码错误不会登录", await phase(D.page) === "anon", await phase(D.page));
  await D.page.evaluate(() => { document.querySelector("#acctPass").value = "newpass123"; });
  await D.page.click("#acctGo");
  await D.page.waitForFunction(() => SYNC.phase() === "on", { timeout: 20000 });
  check("11.3 用重置后的新密码可登录", await phase(D.page) === "on");
  await D.page.click('#acct .close');

  section("12 file:// 直接打开（离线降级）");
  const F = await newDevice("本地文件");
  await F.page.goto("file://" + join(root, "index.html"), { waitUntil: "domcontentloaded" });
  await F.page.waitForFunction(() => typeof SYNC !== "undefined", { timeout: 15000 });
  await F.page.waitForFunction(() => SYNC.phase() === "offline", { timeout: 10000 }).catch(() => {});
  check("12.1 file:// 下 phase = offline", await phase(F.page) === "offline", await phase(F.page));
  check("12.2 账号按钮显示「离线」", (await F.page.$eval("#acctBtn .who", e => e.textContent)).trim() === "离线");
  check("12.3 页面核心内容仍然正常（内置卡组仍在）", await F.page.evaluate(() => META_DECKS.length) === 120);
  await F.page.evaluate(() => { activeTab = "hot1v1"; render(); });
  await sleep(500);
  check("12.4 file:// 下卡组照常渲染", await F.page.evaluate(() => document.querySelectorAll("#decks .deck").length) > 0);
  await F.page.click("#acctBtn");
  await sleep(300);
  check("12.5 file:// 下点账号按钮只提示，不弹窗", !(await F.page.evaluate(() => document.querySelector("#acct").open)));
  await F.page.evaluate(() => { decks.push(normDeck({ name: "离线建的", cards: META_DECKS[0].cards.map(c => ({ id: c.id, v: c.v })), tower: 159000000 })); saveDecks(decks); render(); });
  await sleep(300);
  check("12.6 file:// 下依然可以正常建卡组", await F.page.evaluate(() => decks.length) === 1);
  check("12.7 file:// 下没有访问过后端", F.errors.filter(e => /api\//.test(e)).length === 0, JSON.stringify(F.errors.slice(0, 2)));

  section("13 控制台错误检查");
  // 启动时探测 /api/me 得到 401 是预期行为，浏览器会把它记为一条 console error，这里排除掉
  const benign = e => /favicon|net::ERR|status of 401/.test(e);
  const errsA = A.errors.filter(e => !benign(e));
  const errsB = B.errors.filter(e => !benign(e));
  check("13.1 设备A 无 JS 报错", errsA.length === 0, JSON.stringify(errsA.slice(0, 3)));
  check("13.2 设备B 无 JS 报错", errsB.length === 0, JSON.stringify(errsB.slice(0, 3)));

  section("13.5 手机端排版（393×851）");
  {
    await D.page.setViewport({ width: 393, height: 851, isMobile: true, hasTouch: true });
    await D.page.evaluate(() => { activeTab = "1v1"; render(); });
    await sleep(600);
    const fit = await D.page.evaluate(() => {
      const tabs = document.querySelector("#tabs");
      const last = tabs.querySelector(".tab:last-child").getBoundingClientRect();
      const box = tabs.getBoundingClientRect();
      const rows = new Set([...tabs.querySelectorAll(".tab")].map(t => Math.round(t.getBoundingClientRect().top))).size;
      const wrap = document.querySelector(".wrap").getBoundingClientRect();
      const decks = [...document.querySelectorAll("#decks .deck")].map(d => d.getBoundingClientRect());
      return {
        lastTabRight: Math.round(last.right),
        lastTabBottom: Math.round(last.bottom),
        tabsRight: Math.round(box.right),
        tabsBottom: Math.round(box.bottom),
        tabRows: rows,
        tabsScrollW: tabs.scrollWidth,
        tabsClientW: tabs.clientWidth,
        deckOverflow: decks.filter(d => Math.round(d.right) > Math.round(wrap.right) + 1).length,
        tabLabels: [...tabs.querySelectorAll(".tab")].map(t => t.textContent.trim()),
      };
    });
    check("13.5.1 手机上 6 个标签全部可见（自动换行，不裁切）",
      fit.lastTabRight <= fit.tabsRight + 1 && fit.lastTabBottom <= fit.tabsBottom + 1 &&
      fit.tabsScrollW <= fit.tabsClientW + 1, JSON.stringify(fit));
    check("13.5.2 六个标签齐全且顺序不变",
      fit.tabLabels.join(",") === "1v1,HOT 1v1,决斗,HOT 决斗,2v2,HOT 2v2", fit.tabLabels.join(","));
    check("13.5.3 卡组卡片没有横向溢出", fit.deckOverflow === 0, `溢出 ${fit.deckOverflow} 张`);
    await D.page.setViewport({ width: 1360, height: 950 });
  }

  section("13.6 同步在飞行时新增卡组不能丢（回归测试）");
  {
    // 复现条件：一次同步请求还在飞的时候本地又改了东西。
    // 本地跑不出问题（往返 5ms），线上往返 5–7 秒，窗口很大 ——
    // 曾经的表现是：响应回来后 applyServer() 拿服务端的空列表覆盖本地，新卡组凭空消失。
    const cdp = await D.page.createCDPSession();
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 3500,
      downloadThroughput: 10 * 1024 * 1024 / 8, uploadThroughput: 5 * 1024 * 1024 / 8,
    });
    const before = await D.page.evaluate(() => decks.length);
    await D.page.evaluate(() => { SYNC.flush(); });          // 故意不等它返回
    await sleep(200);                                        // 此刻请求正在路上
    await D.page.evaluate(() => {
      decks.push(normDeck({
        name: "飞行中新增", cards: META_DECKS[2].cards.map(c => ({ id: c.id, v: c.v })),
        tower: 159000000, updatedAt: Date.now(),
      }));
      saveDecks(decks); render();
    });
    check("13.6.1 本地已新增（同步确实还在飞）", await D.page.evaluate(() => decks.length) === before + 1);

    let landed = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const c = await cloud(D.page).catch(() => null);
      if (c && c.ok && c.decks.some(d => d.name === "飞行中新增")) { landed = true; break; }
      await sleep(500);
    }
    check("13.6.2 最终同步到云端（没有被飞行中的响应覆盖掉）", landed);
    check("13.6.3 本地也还在", await D.page.evaluate(() => decks.some(d => d.name === "飞行中新增")));

    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    await D.page.evaluate(() => {
      decks = decks.filter(d => d.name !== "飞行中新增");
      saveDecks(decks); render();
    });
    await checkSoon(D.page, () => !SYNC._state().busy, "13.6.4 收尾同步已完成");
  }

  section("13.7 HOT 决斗：4 套卡组为一个整体");
  {
    await D.page.evaluate(() => { activeTab = "hotduel"; render(); });
    await sleep(900);
    const g = await D.page.evaluate(() => {
      const combos = [...document.querySelectorAll("#decks .duel")];
      const rows = [...document.querySelectorAll("#decks .duelrow")];
      return {
        combos: combos.length,
        rows: rows.length,
        per: combos.map(c => c.querySelectorAll(".duelrow").length),
        cardsPerRow: rows.map(r => r.querySelectorAll(".thumbs .t").length),
        viewBtns: document.querySelectorAll("#decks .duelrow .opbtn.view").length,
        cols: getComputedStyle(document.querySelector("#decks")).gridTemplateColumns,
        title: document.querySelector("#secTitle").textContent,
        heads: combos.slice(0, 1).map(c => c.querySelector(".dhead").textContent.replace(/\s+/g, " ").trim()),
      };
    });
    check("13.7.1 渲染出 10 个决斗组合", g.combos === 10, `combos=${g.combos}`);
    check("13.7.2 每个组合都是 4 套（共 40 套）", g.rows === 40 && g.per.every(n => n === 4), JSON.stringify(g.per));
    check("13.7.3 每套都渲染出 8 张卡", g.cardsPerRow.every(n => n === 8), JSON.stringify(g.cardsPerRow.slice(0, 3)));
    check("13.7.4 每套都有「查看」按钮", g.viewBtns === 40, `view=${g.viewBtns}`);
    check("13.7.5 组合卡片占满整行（没被挤成多列）", g.cols.trim().split(/\s+/).length === 1, g.cols);
    check("13.7.6 区块标题 = 热门决斗组合", g.title === "热门决斗组合", g.title);
    check("13.7.7 组合卡片带排名与胜率", /#1.*组合胜率.*%/.test(g.heads[0] || ""), g.heads[0]);

    await D.page.click('#decks .duelrow[data-ci="0"][data-di="1"]');
    await D.page.waitForSelector("#detail[open]", { timeout: 5000 });
    const dt = await D.page.evaluate(() => ({
      cards: document.querySelectorAll("#dCards .c").length,
      link: document.querySelector("#linkText").textContent,
      title: document.querySelector("#dTitle").textContent,
    }));
    check("13.7.8 点组合里的一套 → 详情弹窗（8 张卡 + 导入链接）",
      dt.cards === 8 && dt.link.includes("copyDeck"), JSON.stringify({ cards: dt.cards, link: dt.link.slice(0, 40) }));
    await D.page.evaluate(() => { document.querySelector("#detail").close(); });

    await D.page.evaluate(() => { activeTab = "duel"; render(); });
    await sleep(400);
    const duelTab = await D.page.evaluate(() => ({
      title: document.querySelector("#secTitle").textContent,
      dev: getComputedStyle(document.querySelector("#devbox")).display !== "none",
    }));
    check("13.7.9 「决斗」已改名（仍是开发中占位）", duelTab.title === "决斗" && duelTab.dev, JSON.stringify(duelTab));
  }

  section("14 截图（三套主题 + 账号弹窗）");
  const shot = join(root, "dist");
  await D.page.evaluate(() => {
    decks = META_DECKS.slice(0, 4).map((d, i) => normDeck({
      name: d.name, cards: d.cards.map(c => ({ id: c.id, v: c.v })), tower: d.tower,
      id: "shot" + String(i).padStart(12, "0"), updatedAt: Date.now(),
    }));
    saveDecks(decks);
    activeTab = "1v1"; render();
  });
  // 等卡图加载完（headless 没缓存，每张 130–210KB），最多等 25 秒
  await D.page.evaluate(() => new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      const imgs = [...document.images];
      const done = imgs.length > 0 && imgs.every(i => i.complete);
      if (done || Date.now() - t0 > 25000) return resolve(imgs.filter(i => i.complete).length);
      setTimeout(tick, 250);
    };
    tick();
  }));
  for (const t of ["light", "space", "neon"]) {
    await D.page.evaluate(th => { curTheme = th; applyTheme(th); }, t);
    await sleep(400);
    await D.page.screenshot({ path: join(shot, `theme-${t}.png`) });
  }
  await D.page.evaluate(() => { curTheme = "light"; applyTheme("light"); activeTab = "hotduel"; render(); });
  await sleep(2500);
  await D.page.screenshot({ path: join(shot, "ui-hotduel.png"), clip: { x: 0, y: 0, width: 1360, height: 1000 } });
  await D.page.evaluate(() => { activeTab = "1v1"; render(); });
  await sleep(600);
  await D.page.click("#acctBtn");
  await D.page.waitForSelector("#acct[open]", { timeout: 5000 });
  await sleep(400);
  await D.page.screenshot({ path: join(shot, "ui-account.png") });
  await D.page.click("#acct .close");
  console.log("  截图已保存到 dist/theme-*.png、dist/ui-account.png");

  if (REMOTE) {
    section("15 清理：删掉这次跑远端用的测试账号");
    const st = await D.page.evaluate(async () => {
      const r = await fetch("api/me", {
        method: "DELETE", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      return r.status;
    });
    check("15.1 云端测试账号已删除（不留垃圾数据）", st === 200, "status=" + st);
    check("15.2 删除后立即失效", (await phase(D.page)) === "on");
  }
  for (const d of [A, B]) await d.context.close().catch(() => {});
} catch (e) {
  console.error("\n× 测试中断：" + e.message);
  for (const d of [A, B]) {
    console.error(`\n[${d.label}] 页面日志：`);
    (await d.page.evaluate(() => ({
      phase: typeof SYNC !== "undefined" ? SYNC.phase() : "(无 SYNC)",
      msg: document.querySelector("#acctMsg") ? document.querySelector("#acctMsg").textContent : "",
      msgClass: document.querySelector("#acctMsg") ? document.querySelector("#acctMsg").className : "",
      who: document.querySelector("#acctBtn .who").textContent,
      decks: typeof decks !== "undefined" ? decks.map(x => x.name) : null,
      sync: typeof SYNC !== "undefined" && SYNC._state ? SYNC._state() : null,
    })).then(v => console.error("   " + JSON.stringify(v))).catch(() => console.error("   (页面已关闭)")));
    d.errors.slice(-8).forEach(l => console.error("   " + l));
    console.error(`   —— 网络 ——`);
    d.net.slice(-14).forEach(l => console.error("   " + l));
  }
  throw e;
} finally {
  if (!KEEP) {
    await browser.close().catch(() => {});
    cleanup();
  }
}

console.log("\n" + "=".repeat(56));
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log(`✓ 端到端测试全部通过（${passed} 项）`);
