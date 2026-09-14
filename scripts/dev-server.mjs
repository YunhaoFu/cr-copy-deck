#!/usr/bin/env node
/**
 * 本地开发服务器：用 node:sqlite 顶替 Cloudflare D1，把 index.html 和 functions/api/* 一起跑起来。
 * 这样不用装 wrangler、不联网也能在本地把账号 + 云同步完整走一遍。
 *
 * 用法：
 *   node scripts/dev-server.mjs                # 内存库（每次重启清空），端口 8788
 *   node scripts/dev-server.mjs --port 9000
 *   node scripts/dev-server.mjs --db .dev.db   # 落盘，重启后数据还在
 *
 * 说明：Cookie 在这一层没有 HTTPS，浏览器会对 http://localhost 放行 Secure Cookie；
 * 用 IP（非 localhost）访问时可能被拒，所以请用 http://localhost:<port> 打开。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createD1 } from "./lib/sqlite-d1.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf("--port", process.env.PORT || 8788));
const DB_PATH = argOf("--db", ":memory:");

const db = createD1(DB_PATH);

const API = {
  "/api/auth": () => import("../functions/api/auth.js"),
  "/api/me": () => import("../functions/api/me.js"),
  "/api/sync": () => import("../functions/api/sync.js"),
};

const env = {
  CR_DB: db,
  PASSWORD_PEPPER: process.env.PASSWORD_PEPPER || "dev-pepper-not-for-production",
  SESSION_PEPPER: process.env.SESSION_PEPPER || "dev-session-pepper",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function readRaw(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function toHeaders(nodeHeaders) {
  const h = new Headers();
  for (const [k, v] of Object.entries(nodeHeaders)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach(x => h.append(k, x));
    else h.set(k, String(v));
  }
  return h;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  // ---- API：交给 Pages Functions ----
  const loader = API[path];
  if (loader) {
    try {
      const mod = await loader();
      const fnName = { GET: "onRequestGet", POST: "onRequestPost", PUT: "onRequestPut", DELETE: "onRequestDelete" }[req.method];
      const fn = fnName && mod[fnName];
      if (!fn) {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
        return;
      }
      const request = new Request(url.href, {
        method: req.method,
        headers: toHeaders(req.headers),
        body: await readRaw(req),
        duplex: "half",
      });
      const out = await fn({ request, env, waitUntil: p => { Promise.resolve(p).catch(() => {}); }, next: () => new Response("next") });
      const headers = {};
      out.headers.forEach((v, k) => { if (k.toLowerCase() !== "set-cookie") headers[k] = v; });
      const cookies = out.headers.getSetCookie ? out.headers.getSetCookie() : [];
      if (cookies.length) headers["set-cookie"] = cookies;
      res.writeHead(out.status, headers);
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e) {
      console.error("[api error]", path, e);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "internal_error", detail: String(e && e.message) }));
    }
    return;
  }

  // ---- 静态：单文件站点 ----
  const file = path === "/" || path === "/index.html" ? "index.html" : null;
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404（本地开发服务器只提供 index.html 和 /api/*）");
    return;
  }
  try {
    const buf = await readFile(join(root, file));
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
    res.end(buf);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("读取 index.html 失败：" + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`本地开发服务器：http://localhost:${PORT}`);
  console.log(`  · 静态文件 index.html + API /api/{auth,me,sync}`);
  console.log(`  · 数据库：${DB_PATH === ":memory:" ? "内存（重启即清空）" : DB_PATH}`);
  console.log(`  · 注意：请用 localhost 访问（Secure Cookie 在纯 IP 的 http 下会被浏览器丢弃）`);
});
