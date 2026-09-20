/* ============================================================
   白给Turbo · 作品导航页  —  自动发现逻辑
   ------------------------------------------------------------
   原理：页面打开时实时调用 GitHub 公开 API 拉取仓库列表，
        筛选出「已开启 GitHub Pages」的仓库，
        自动拼出在线演示地址并渲染成卡片。
        你在 GitHub 上新建仓库 + 开启 Pages 之后，
        访客刷新页面就能看到，不需要改这个文件里的任何东西。

   想改标题/描述/顺序 → 编辑根目录的 links.json
   ============================================================ */

'use strict';

/* ---------- 默认配置（会被 links.json 里的同名项覆盖） ---------- */

const DEFAULTS = {
  options: {
    username: 'FreeTurbo',                  // GitHub 用户名
    pagesBase: 'https://freeturbo.github.io', // Pages 站点根地址
    exclude: [],                            // 不想显示的仓库名（小写）
    requirePages: true,                     // 只显示已开启 Pages 的仓库
    hideForks: true,                        // 隐藏 fork 来的仓库
    cacheMinutes: 5,                        // 本地缓存分钟数，减少 API 请求
    newDays: 14,                            // 多少天内更新的打「新」标
    minProjectsForSearch: 9                 // 作品数达到多少才显示搜索框
  },
  order: [],   // 手动指定排序，没列到的排在后面（按更新时间）
  hidden: [],  // 手动隐藏的仓库名
  projects: {} // 每个仓库的自定义标题 / 描述 / 标签 / 配色
};

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', HTML: '#e34c26', CSS: '#563d7c',
  Python: '#3572A5', Vue: '#41b883', Svelte: '#ff3e00', Java: '#b07219',
  'C++': '#f34b7d', C: '#555555', 'C#': '#178600', Go: '#00ADD8', Rust: '#dea584',
  Ruby: '#701516', PHP: '#4F5D95', Swift: '#F05138', Kotlin: '#A97BFF',
  Dart: '#00B4AB', Shell: '#89e051', GLSL: '#5686a5', 'Jupyter Notebook': '#DA5B0B'
};

/* ---------- DOM ---------- */

const $ = (sel) => document.querySelector(sel);

const el = {
  grid:        $('#grid'),
  toolbar:     $('#toolbar'),
  search:      $('#search'),
  count:       $('#stat-count'),
  sync:        $('#sync-state'),
  syncDot:     $('#sync-dot'),
  footCount:   $('#foot-count'),
  year:        $('#year')
};

/* ---------- 工具 ---------- */

/** 把仓库名变成好看点的标题：gaussian-splat-viewer → Gaussian Splat Viewer */
function humanize(name) {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** 相对时间：3 天前 */
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return '今天更新';
  if (days === 1) return '昨天更新';
  if (days < 30) return `${days} 天前更新`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前更新`;
  return `${Math.floor(months / 12)} 年前更新`;
}

function isFresh(iso, days) {
  const then = new Date(iso).getTime();
  return !Number.isNaN(then) && Date.now() - then < days * 86400000;
}

/** 拼出这个仓库的在线演示地址 */
function demoUrl(repo, opts) {
  const home = (repo.homepage || '').trim();
  if (/^https?:\/\//i.test(home)) return home.replace(/\/+$/, '') + '/';
  return `${opts.pagesBase.replace(/\/+$/, '')}/${repo.name}/`;
}

/* ---------- 数据 ---------- */

let ALL = [];        // 渲染用的项目列表
let query = '';

/**
 * 读取仓库里的静态快照（repos.json）。
 *
 * 用途：浏览器直连 GitHub API 被拦截时兜底。典型场景是访客装了 GitHub
 * 加速器（Steam++ / Watt Toolkit 之类），它们会把 api.github.com 通过
 * hosts 指向 127.0.0.1，而 Chromium 禁止公网页面请求「回环地址空间」，
 * 于是 fetch 直接失败。快照由 .github/workflows/refresh-repos.yml 每天刷新。
 */
async function fetchSnapshot() {
  const res = await fetch('repos.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('no-snapshot');
  const data = await res.json();
  const at = data.generated_at ? new Date(data.generated_at).getTime() : null;
  return { repos: data.repos || [], at };
}

/** 从 GitHub API 拉仓库，失败时依次回落到本地缓存 → 静态快照 */
async function fetchRepos(opts) {
  const key = 'ft-portal-cache-v1';
  const ttl = opts.cacheMinutes * 60 * 1000;
  let cached = null;

  try {
    const raw = localStorage.getItem(key);
    if (raw) cached = JSON.parse(raw);
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }

  const fresh = cached && Date.now() - cached.at < ttl;
  if (fresh) {
    return { repos: cached.repos, source: 'cache', at: cached.at };
  }

  const api = `https://api.github.com/users/${encodeURIComponent(opts.username)}`
            + `/repos?per_page=100&sort=pushed`;

  try {
    const res = await fetch(api, { headers: { Accept: 'application/vnd.github+json' } });

    if (!res.ok) {
      if (res.status === 403 || res.status === 429) throw new Error('rate-limit');
      throw new Error('http-' + res.status);
    }

    const repos = await res.json();
    const at = Date.now();
    try { localStorage.setItem(key, JSON.stringify({ at, repos })); } catch { /* 忽略 */ }
    return { repos, source: 'network', at };

  } catch (err) {
    // 直连 GitHub API 失败 → 有旧缓存用旧缓存
    if (cached) return { repos: cached.repos, source: 'stale', at: cached.at };

    // 没有缓存 → 用仓库里的静态快照兜底
    try {
      const snap = await fetchSnapshot();
      if (snap.repos.length) return { repos: snap.repos, source: 'snapshot', at: snap.at };
    } catch { /* 快照也读不到，继续往下抛 */ }

    throw err;
  }
}

/** 仓库列表 → 项目卡片数据 */
function buildProjects(repos, cfg) {
  const opts = cfg.options;
  const hidden = new Set((cfg.hidden || []).map((s) => s.toLowerCase()));
  const exclude = new Set((opts.exclude || []).map((s) => s.toLowerCase()));
  const selfName = `${opts.username}.github.io`.toLowerCase();

  const list = repos
    .filter((r) => {
      const n = r.name.toLowerCase();
      if (n === selfName) return false;         // 导航页自己不列出自己
      if (hidden.has(n) || exclude.has(n)) return false;
      if (r.archived || r.disabled) return false;
      if (opts.hideForks && r.fork) return false;
      if (opts.requirePages && !r.has_pages) return false;
      return true;
    })
    .map((r) => {
      const custom = cfg.projects?.[r.name] || {};
      const pushed = r.pushed_at || r.updated_at;
      return {
        name: r.name,
        title: custom.title || humanize(r.name),
        desc: custom.description || r.description || '',
        tags: custom.tags || (r.language ? [r.language] : []),
        tint: custom.tint || null,
        url: demoUrl(r, opts),
        lang: r.language,
        langColor: LANG_COLORS[r.language] || null,
        pushed,
        ago: timeAgo(pushed),
        isNew: isFresh(pushed, opts.newDays),
        stars: r.stargazers_count || 0
      };
    });

  // 排序：order 里写了的按写的顺序排前面，其余按更新时间
  const rank = new Map((cfg.order || []).map((n, i) => [n.toLowerCase(), i]));
  list.sort((a, b) => {
    const ra = rank.has(a.name.toLowerCase()) ? rank.get(a.name.toLowerCase()) : Infinity;
    const rb = rank.has(b.name.toLowerCase()) ? rank.get(b.name.toLowerCase()) : Infinity;
    if (ra !== rb) return ra - rb;
    return new Date(b.pushed) - new Date(a.pushed);
  });

  return list;
}

/* ---------- 渲染 ---------- */

const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const ICON_ARROW  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>';

function renderSkeleton(n = 6) {
  el.grid.innerHTML = Array.from({ length: n }, (_, i) => `
    <div class="skeleton" style="--i:${i}">
      <div class="sk-line sk-w-30"></div>
      <div class="sk-line sk-w-70" style="margin-top:1.1rem"></div>
      <div class="sk-line sk-w-95" style="margin-top:1rem"></div>
      <div class="sk-line sk-w-55"></div>
    </div>`).join('');
}

function cardHTML(p, i) {
  const tint = p.tint || p.langColor || '#6d5efc';
  const badges = [
    p.isNew ? '<span class="badge">新</span>' : '',
    p.stars > 0 ? `<span class="badge">★ ${p.stars}</span>` : ''
  ].join('');

  const tags = p.tags.slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('');

  return `
  <a class="card" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"
     style="--i:${i};--tint:${esc(tint)}"
     aria-label="${esc(p.title)} — 打开在线演示">
    <div class="card-head">
      <span class="card-index">${String(i + 1).padStart(2, '0')}</span>
      <span class="card-badges">${badges}</span>
    </div>
    <h3 class="card-title">${esc(p.title)}</h3>
    ${p.desc ? `<p class="card-desc">${esc(p.desc)}</p>` : ''}
    <div class="card-foot">
      <span class="tags">${tags}</span>
      <span class="card-go">${p.ago ? esc(p.ago.replace('更新', '')) : '打开'} ${ICON_ARROW}</span>
    </div>
  </a>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  const q = query.trim().toLowerCase();
  const list = q
    ? ALL.filter((p) => (p.title + ' ' + p.name + ' ' + p.desc + ' ' + p.tags.join(' '))
        .toLowerCase().includes(q))
    : ALL;

  if (!list.length) {
    el.grid.innerHTML = `
      <div class="state">
        <div class="state-icon">${q ? '🔍' : '📦'}</div>
        <h3>${q ? '没有匹配的作品' : '还没有已上线的作品'}</h3>
        <p>${q
          ? '换个关键词试试。'
          : '新建仓库后，到仓库的 <code>Settings → Pages</code> 把 Pages 打开，刷新本页就会自动出现。'}</p>
      </div>`;
    return;
  }

  el.grid.innerHTML = list.map(cardHTML).join('');
}

function renderError(err) {
  const rate = err && err.message === 'rate-limit';
  el.grid.innerHTML = `
    <div class="state">
      <div class="state-icon">${rate ? '⏳' : '📡'}</div>
      <h3>${rate ? 'GitHub 接口请求太频繁了' : '没能读取到仓库列表'}</h3>
      <p>${rate
        ? 'GitHub 对未登录的访问有限流（每小时 60 次）。等几分钟再刷新就好。'
        : '浏览器没能连上 GitHub 接口。<br>如果你开着 GitHub 加速器（Steam++、Watt Toolkit 等），'
          + '它会把 api.github.com 指向本机，浏览器会拦截这种请求 —— 关掉加速器再刷新即可。'}</p>
      <button type="button" id="retry">重新加载</button>
    </div>`;
  const btn = $('#retry');
  if (btn) btn.addEventListener('click', () => boot());
}

function setSync(source, at) {
  if (!el.sync) return;
  const label = {
    network: '实时同步自 GitHub',
    cache: '已同步 · 本地缓存',
    snapshot: '离线快照',
    stale: '离线显示上次结果'
  }[source] || '已同步';

  const time = at
    ? new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
    : '';
  el.sync.textContent = time ? `${label} · ${time}` : label;

  if (el.syncDot) {
    el.syncDot.classList.toggle('stale', source === 'stale' || source === 'snapshot');
  }
}

function setCount(n) {
  if (el.count) el.count.textContent = n;
  if (el.footCount) el.footCount.textContent = n;
}

/* 鼠标跟随聚光 */
function bindSpotlight() {
  el.grid.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
    card.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
  }, { passive: true });
}

/* ---------- 启动 ---------- */

async function loadConfig() {
  try {
    const res = await fetch('links.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('no config');
    const user = await res.json();
    return {
      options:  { ...DEFAULTS.options,  ...(user.options  || {}) },
      order:    user.order    || DEFAULTS.order,
      hidden:   user.hidden   || DEFAULTS.hidden,
      projects: { ...DEFAULTS.projects, ...(user.projects || {}) },
      site:     user.site || {}
    };
  } catch {
    return { ...DEFAULTS, site: {} };
  }
}

function applySite(site) {
  if (!site) return;
  const set = (sel, val) => { const n = $(sel); if (n && val) n.textContent = val; };
  set('#site-name', site.name);
  set('#site-tagline', site.tagline);
  set('#site-bio', site.bio);
  set('#site-brand', site.name);
  if (site.github) {
    const g = $('#site-github');
    if (g) g.href = site.github;
  }
  if (site.name) document.title = `${site.name} · 作品集`;
}

async function boot() {
  renderSkeleton();
  const cfg = await loadConfig();
  applySite(cfg.site);

  try {
    const { repos, source, at } = await fetchRepos(cfg.options);
    ALL = buildProjects(repos, cfg);
    setCount(ALL.length);
    setSync(source, at);

    if (el.toolbar) {
      el.toolbar.hidden = ALL.length < cfg.options.minProjectsForSearch;
    }
    render();
  } catch (err) {
    console.warn('[portal] 读取仓库失败：', err);
    setSync('stale', null);
    renderError(err);
  }
}

function init() {
  if (el.year) el.year.textContent = new Date().getFullYear();
  if (el.search) {
    let timer;
    el.search.addEventListener('input', (e) => {
      clearTimeout(timer);
      const v = e.target.value;
      timer = setTimeout(() => { query = v; render(); }, 120);
    });
  }
  bindSpotlight();
  boot();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
