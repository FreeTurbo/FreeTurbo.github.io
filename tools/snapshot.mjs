/**
 * 生成作品快照 repos.json
 *
 * 为什么要这个文件：
 *   页面优先实时调用 GitHub API。但访客如果装了 GitHub 加速器
 *   （Steam++ / Watt Toolkit 等），那些工具会把 api.github.com 通过 hosts
 *   指向 127.0.0.1，Chromium 会以「不允许公网页面访问回环地址」为由拦截请求。
 *   这时页面回落到这份静态快照，至少不会开天窗。
 *
 * 什么时候跑：
 *   .github/workflows/refresh-repos.yml 每天自动跑一次，也在手动触发时跑。
 *   在 Actions 的机器上不存在 hosts 劫持问题，所以能正常拿到数据。
 *
 * 本地手动跑：
 *   node tools/snapshot.mjs
 *   （注意：本机若开着加速器，Node 可能因证书问题失败，加 --use-system-ca）
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const USER = process.env.GH_USER || 'FreeTurbo';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'repos.json');

// 只保留页面真正用得到的字段，让快照尽量小
const FIELDS = [
  'name', 'description', 'homepage', 'has_pages', 'fork',
  'archived', 'disabled', 'language', 'pushed_at', 'updated_at',
  'stargazers_count', 'html_url'
];

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'freeturbo-portal-snapshot'
};

// Actions 里带上 token 可以拿到 5000 次/小时，也不受共享 IP 限流影响
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

const url = `https://api.github.com/users/${encodeURIComponent(USER)}/repos`
          + `?per_page=100&sort=pushed`;

const res = await fetch(url, { headers });

if (!res.ok) {
  console.error(`请求 GitHub API 失败：HTTP ${res.status}`);
  console.error(await res.text().catch(() => ''));
  process.exit(1);
}

const raw = await res.json();

if (!Array.isArray(raw)) {
  console.error('返回的不是数组，中止');
  process.exit(1);
}

// 必须排除导航页自己的仓库，原因有两个：
//   1. 页面上本来就不该列出自己
//   2. 它每次被推送 pushed_at 都会变，而本 workflow 的提交又算一次推送
//      → 快照每天都变 → 每天都产生一次无意义的自动提交和 Pages 重建
const selfName = `${USER}.github.io`.toLowerCase();
const skipped = [];
const kept = raw.filter((r) => {
  if (String(r.name).toLowerCase() === selfName) {
    skipped.push(r.name);
    return false;
  }
  return true;
});

const repos = kept.map((r) => Object.fromEntries(FIELDS.map((k) => [k, r[k] ?? null])));

/**
 * 仓库数据没变就一个字节都不写。
 *
 * 为什么必须这么做：generated_at 是当前时间，只要写文件就必然和上一版不同，
 * 于是 workflow 里的 `git diff --quiet` 永远判定为「有变化」，
 * 每天都会产生一次无意义的自动提交，并连带触发一次 Pages 重建。
 * 所以这里先比对 repos 数组本身，没变就直接退出。
 */
let prev = null;
try {
  prev = JSON.parse(await readFile(OUT, 'utf8'));
} catch { /* 首次生成，没有旧文件 */ }

const unchanged = prev && JSON.stringify(prev.repos) === JSON.stringify(repos);

if (unchanged) {
  console.log('仓库数据没有变化，保持原文件不动（不产生提交）');
} else {
  // generated_at 的含义是「这份数据是什么时候的」，只有数据变了才刷新
  const payload = {
    generated_at: new Date().toISOString(),
    user: USER,
    count: repos.length,
    repos
  };

  await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`已写入 ${OUT}`);
  console.log(`共 ${repos.length} 个仓库，其中开启 Pages 的 ${repos.filter((r) => r.has_pages).length} 个`);
}

if (skipped.length) console.log(`已排除导航页自身：${skipped.join(', ')}`);
