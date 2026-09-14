#!/usr/bin/env node
/**
 * 构建：把仓库根目录的单文件 index.html 复制到 dist/
 *
 * 站点是零依赖的单文件应用，不需要打包；这一步只是为了：
 *   1) 只把站点文件发布到 CDN（不暴露 README.md / scripts/ / .github/ / .git）
 *   2) 给将来"构建期刷新卡组数据"留一个注入点（refresh 脚本可在此前改 dist/index.html）
 *
 * 用法：node scripts/build-site.mjs
 */
import { mkdirSync, copyFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "index.html");
const outDir = join(root, "dist");
const out = join(outDir, "index.html");

if (!existsSync(src)) {
  console.error(`✗ 找不到源文件：${src}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(src, out);

const size = statSync(out).size;
console.log(`✓ 构建完成：dist/index.html（${(size / 1024).toFixed(1)} KB）`);
