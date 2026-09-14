#!/usr/bin/env node
/**
 * 构建：把仓库根目录的单文件 index.html 复制到 dist/
 *
 * 站点是零依赖的单文件应用，不需要打包；这一步只是为了：
 *   1) 只把站点文件发布到 CDN（不暴露 README.md / scripts/ / .github/ / .git）
 *   2) 把 _routes.json 带进产物，让 /api/* 走 Pages Functions、静态资源不触发函数
 *
 * 用法：node scripts/build-site.mjs
 */
import { mkdirSync, copyFileSync, statSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist");

const files = ["index.html", "_routes.json"];
const sizes = [];

// 先清空产物目录：避免上次构建遗留的文件被一起发布出去
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const name of files) {
  const src = join(root, name);
  if (!existsSync(src)) {
    console.error(`✗ 找不到源文件：${src}`);
    process.exit(1);
  }
  const out = join(outDir, name);
  copyFileSync(src, out);
  sizes.push([name, statSync(out).size]);
}

// 校验 _routes.json 合法且只把 /api/* 指给 Functions
try {
  const routes = JSON.parse(
    await import("node:fs/promises").then(fs => fs.readFile(join(outDir, "_routes.json"), "utf8"))
  );
  const onlyApi =
    routes && routes.version === 1 &&
    Array.isArray(routes.include) && routes.include.length === 1 && routes.include[0] === "/api/*" &&
    Array.isArray(routes.exclude) && routes.exclude.length === 0;
  if (!onlyApi) {
    console.error("× dist/_routes.json 内容不符合预期（应恰好为 include:[\"/api/*\"], exclude:[]）");
    process.exit(1);
  }
} catch (e) {
  console.error("× dist/_routes.json 解析失败：" + e.message);
  process.exit(1);
}

console.log("✓ 构建完成：" + sizes.map(([n, s]) => `dist/${n}（${(s / 1024).toFixed(1)} KB）`).join(" + "));
