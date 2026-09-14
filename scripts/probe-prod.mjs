#!/usr/bin/env node
/**
 * 线上认证链路探测：确认 PBKDF2 迭代数没有撞上 Workers 免费版的 10ms CPU 上限。
 *
 * 背景：Cloudflare Workers 免费版单请求 CPU 上限 10ms，超了会直接抛 Error 1102
 * （进程被运行时终止，代码里 catch 不住，对外表现为 5xx）。PBKDF2 是整条认证链路里
 * 唯一的重计算，迭代数必须在「够安全」和「不超预算」之间取舍，所以需要拿真实部署来量。
 *
 * 用 node:https + agent:false 而不是 fetch：本机的透明代理与 undici 的连接复用不兼容，
 * 同一进程里第二个 TLS 连接会被切断（curl 正常、fetch 报 socket disconnected）。
 *
 * 用法：
 *   node scripts/probe-prod.mjs                        # 默认打 https://cr-copy-deck.pages.dev
 *   node scripts/probe-prod.mjs --base http://localhost:8788/ --times 5
 *
 * 退出码：全部 2xx → 0；出现任何 5xx → 1（说明要调 PBKDF2_ITERATIONS）。
 */
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const BASE = (argOf("--base", process.env.PROBE_BASE || "https://cr-copy-deck.pages.dev/")).replace(/\/?$/, "/");
const TIMES = Math.max(3, Math.min(20, Number(argOf("--times", 8))));
const GAP_MS = Number(argOf("--gap", 3000));
const PASSWORD = "probe-" + Math.random().toString(36).slice(2, 10);
const USERNAME = "probe-" + Date.now().toString(36);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 每次都用新连接（agent:false）+ 只走 IPv4：本机透明代理对连接复用和 IPv6 都不太稳 */
function reqOnce(path, { method = "GET", body, cookie } = {}) {
  const url = new URL(path, BASE);          // 交给 URL 解析，避免手工拼接把 host 和 path 粘在一起
  const isHttps = url.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (payload !== null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  if (cookie) headers.cookie = cookie;

  const t0 = Date.now();
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve({ ...v, ms: Date.now() - t0 }); } };
    const r = doRequest(
      { hostname: url.hostname, port: url.port || undefined, path: url.pathname, method,
        agent: false, family: 4, headers },
      res => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", c => { data += c; });
        res.on("end", () => {
          const raw = res.headers["set-cookie"] || [];
          const sess = raw.find(c => c.startsWith("crsess="));
          done({ status: res.statusCode, text: data, cookie: sess ? sess.split(";")[0] : "" });
        });
      }
    );
    r.on("error", e => done({ status: 0, text: "网络错误：" + e.message, cookie: "" }));
    r.setTimeout(20000, () => { r.destroy(new Error("超时 20s")); });
    if (payload !== null) r.write(payload);
    r.end();
  });
}

/** 网络抖动重试：本机透明代理偶发切断 TLS，不该被误判成服务端故障 */
async function req(path, opts = {}) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await reqOnce(path, opts);
    if (last.status !== 0) return last;
    if (attempt < 3) await sleep(800 * attempt);
  }
  return last;
}

console.log(`探测目标：${BASE}`);
console.log(`临时账号：${USERNAME}\n`);

/* ---- 0. 目标可达性 ---- */
const probe = await req("/api/me");
if (probe.status !== 401 && probe.status !== 200) {
  console.error(`× ${BASE}api/me 返回 ${probe.status} ${probe.text.slice(0, 120)}，预期 401（未登录）。`);
  process.exit(2);
}

/* ---- 1. 注册（触发一次 PBKDF2）---- */
const reg = await req("/api/auth", { method: "POST", body: { action: "register", username: USERNAME, password: PASSWORD } });
if (reg.status !== 201) {
  console.error(`× 注册失败：${reg.status} ${reg.text.slice(0, 200)}`);
  process.exit(2);
}
console.log(`注册成功  ${reg.status}  ${reg.ms} ms`);
let cookie = reg.cookie;

/* ---- 2. 反复登录 ---- */
const rows = [];
for (let i = 1; i <= TIMES; i++) {
  const r = await req("/api/auth", { method: "POST", body: { action: "login", username: USERNAME, password: PASSWORD } });
  rows.push(r);
  const flag = r.status >= 500 ? "  ← 5xx！很可能 CPU 超预算" : r.status !== 200 ? "  ← 非预期" : "";
  console.log(`登录 #${String(i).padStart(2)}  ${r.status}  ${String(r.ms).padStart(5)} ms${flag}`);
  if (r.cookie) cookie = r.cookie;
  if (i < TIMES) await sleep(GAP_MS);
}

/* ---- 3. 清理 ---- */
const del = cookie
  ? await req("/api/me", { method: "DELETE", body: { confirm: "DELETE" }, cookie })
  : { status: 0 };
console.log(`\n清理账号：${del.status === 200 ? "已注销" : `失败（${del.status}），请手动删 ${USERNAME}`}`);

/* ---- 4. 结论 ---- */
const codes = rows.map(r => r.status);
const fiveXx = codes.filter(c => c >= 500);
const okCount = codes.filter(c => c === 200).length;
const sorted = rows.map(r => r.ms).sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length * 0.5)];
const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];

console.log("\n" + "=".repeat(52));
console.log(`状态码：200×${okCount}  其它×${codes.length - okCount}  5xx×${fiveXx.length}`);
console.log(`耗时：p50 ${p50} ms  p95 ${p95} ms（含网络往返，非纯 CPU）`);

if (fiveXx.length) {
  console.log("\n✗ 出现 5xx —— PBKDF2 迭代数很可能超了 10ms CPU 上限。");
  console.log("  处理：Cloudflare → Pages → cr-copy-deck → Settings → Variables and Secrets");
  console.log("        加 PBKDF2_ITERATIONS = 15000 → Retry deployment → 重跑本脚本");
  process.exit(1);
}
if (okCount !== codes.length) {
  console.log("\n⚠ 有非 2xx 且非 5xx 的响应，请人工确认：", JSON.stringify(codes));
  process.exit(1);
}
console.log(`\n✓ 全部成功，PBKDF2 迭代数在当前预算内。`);
