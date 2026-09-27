/* ==========================================================================
   白给Turbo · 作品名录  —  自动发现 + 点云标记
   --------------------------------------------------------------------------
   这个文件做两件事：

   1. 自动发现
      页面打开时实时调用 GitHub 公开 API 拉取仓库列表，筛出「已开启
      GitHub Pages」的仓库，拼出在线演示地址。你在 GitHub 新建仓库并开启
      Pages 之后，访客刷新就能看到，不需要改这里的任何代码。

      直连 API 失败时（典型原因：访客开着 GitHub 加速器，hosts 把
      api.github.com 指向了 127.0.0.1，浏览器会拦截对回环地址的请求）
      自动回落到仓库里的静态快照 repos.json。

   2. 点云标记
      每个作品左侧那个自转的三维点云，是由它的仓库名确定性生成的 ——
      同一个仓库名永远得到同一个形状和配色，新仓库自动获得自己的标记，
      不需要任何图片素材。

   改标题/描述/顺序/配色 → 编辑根目录的 links.json
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   默认配置（会被 links.json 里的同名项覆盖）
   -------------------------------------------------------------------------- */

const DEFAULTS = {
  options: {
    username: 'FreeTurbo',
    pagesBase: 'https://freeturbo.github.io',
    exclude: [],
    requirePages: true,
    hideForks: true,
    cacheMinutes: 5,
    newDays: 14,
    minProjectsForSearch: 9
  },
  order: [],
  hidden: [],
  projects: {}
};

/* 备选色板：links.json 里没写 tint 的仓库，按仓库名从这里面挑一个 */
const PALETTE = [
  '#7dd3fc', '#a78bfa', '#f0abfc', '#6ee7b7',
  '#93c5fd', '#fda4af', '#fcd34d', '#5eead4'
];

const $ = (sel) => document.querySelector(sel);

const el = {
  list:      $('#list'),
  search:    $('#search'),
  searchBox: $('#search-box'),
  count:     $('#count'),
  sync:      $('#sync'),
  syncDot:   $('#sync-dot'),
  footCount: $('#foot-count'),
  year:      $('#year')
};

/* --------------------------------------------------------------------------
   小工具
   -------------------------------------------------------------------------- */

/** FNV-1a：把仓库名变成稳定的数字 */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 可复现的伪随机数 */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const s = String(hex).replace('#', '');
  const v = s.length === 3
    ? s.split('').map((c) => c + c).join('')
    : s.padEnd(6, '0').slice(0, 6);
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 仓库名 → 能看的标题：gaussian-splat-viewer → Gaussian Splat Viewer */
function humanize(name) {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

function isFresh(iso, days) {
  const then = new Date(iso).getTime();
  return !Number.isNaN(then) && Date.now() - then < days * 86400000;
}

function demoUrl(repo, opts) {
  const home = (repo.homepage || '').trim();
  if (/^https?:\/\//i.test(home)) return home.replace(/\/+$/, '') + '/';
  return `${opts.pagesBase.replace(/\/+$/, '')}/${repo.name}/`;
}

/* ==========================================================================
   点云标记
   --------------------------------------------------------------------------
   每个标记是一小块 canvas，点云形状和配色由仓库名哈希决定，
   同一名字永远得到同一结果。载入时点从散乱处聚拢成形，
   之后缓慢自转；鼠标移到这一行时转速加快并朝指针倾斜。
   ========================================================================== */

const mark = {
  instances: [],
  raf: null,
  last: 0,
  epoch: null,                // 第一帧的时间戳，入场动画以它为起点
  frame: 1000 / 30,           // 锁 30fps，六个标记同时跑也不吃力
  reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches
};

/** 生成点云坐标。五种形状按 seed 选一种。 */
function buildCloud(seed, n) {
  const rand = mulberry32(seed);
  const kind = seed % 7;
  const TAO = Math.PI * 2;
  const pos = new Float32Array(n * 3);
  const scat = new Float32Array(n * 3);
  const jit = new Float32Array(n);

  for (let i = 0, k = 0; i < n; i++, k += 3) {
    const u = rand(), v = rand(), w = rand();
    let x, y, z;

    if (kind === 0) {                     // 球壳：像一团扫描点
      const t = Math.acos(1 - 2 * u), p = TAO * v;
      const r = 0.78 + 0.22 * rand();
      x = r * Math.sin(t) * Math.cos(p);
      y = r * Math.cos(t);
      z = r * Math.sin(t) * Math.sin(p);

    } else if (kind === 1) {              // 环面
      const a = TAO * u, b = TAO * v;
      const R = 0.7, rr = 0.3 * (0.75 + 0.5 * rand());
      x = (R + rr * Math.cos(b)) * Math.cos(a);
      y = rr * Math.sin(b) * 1.15;
      z = (R + rr * Math.cos(b)) * Math.sin(a);

    } else if (kind === 2) {              // 螺旋（要给点云厚度，否则细得像根线）
      const t = u * TAO * 2;
      const r = 0.34 + 0.46 * u;
      const thick = 0.16 * (0.4 + rand());
      x = r * Math.cos(t) + (rand() - 0.5) * thick;
      y = (u - 0.5) * 1.42 + (rand() - 0.5) * thick;
      z = r * Math.sin(t) + (rand() - 0.5) * thick;

    } else if (kind === 3) {              // 体素晶格带抖动
      const g = 4;
      x = (Math.floor(u * g) / (g - 1) - 0.5) * 1.42 + (rand() - 0.5) * 0.15;
      y = (Math.floor(v * g) / (g - 1) - 0.5) * 1.42 + (rand() - 0.5) * 0.15;
      z = (Math.floor(w * g) / (g - 1) - 0.5) * 1.42 + (rand() - 0.5) * 0.15;

    } else if (kind === 4) {              // 双瓣
      const t = Math.acos(1 - 2 * u), p = TAO * v;
      const r = 0.5 + 0.42 * Math.abs(Math.cos(2 * t));
      x = r * Math.sin(t) * Math.cos(p);
      y = r * Math.cos(t);
      z = r * Math.sin(t) * Math.sin(p);

    } else if (kind === 5) {              // 陀螺面（gyroid）：填满整个立方的曲面，哪个角度看都饱满
      let guard = 0;
      do {
        x = (rand() - 0.5) * 1.9;
        y = (rand() - 0.5) * 1.9;
        z = (rand() - 0.5) * 1.9;
        guard++;
      } while (guard < 60 && Math.abs(
        Math.sin(x * 2.2) * Math.cos(y * 2.2) +
        Math.sin(y * 2.2) * Math.cos(z * 2.2) +
        Math.sin(z * 2.2) * Math.cos(x * 2.2)) > 0.42);

    } else {                              // 同心环，堆成阶梯圆锥
      // 纯平面的环在 18° 俯角下会缩成一条线，所以让每一环抬高一点
      const ring = Math.floor(u * 4);
      const rr = 0.24 + ring * 0.2;
      const a = v * TAO + ring * 0.9;
      x = rr * Math.cos(a) + (rand() - 0.5) * 0.06;
      y = (ring - 1.5) * 0.28 + (rand() - 0.5) * 0.06;
      z = rr * Math.sin(a) + (rand() - 0.5) * 0.06;
    }

    pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;

    // 入场动画的起点：向外散开
    const sp = 2.4 + rand() * 2.6;
    scat[k] = x * sp + (rand() - 0.5) * 1.6;
    scat[k + 1] = y * sp + (rand() - 0.5) * 1.6;
    scat[k + 2] = z * sp + (rand() - 0.5) * 1.6;

    jit[i] = 0.62 + rand() * 0.78;        // 每点大小略有差异
  }

  return { pos, scat, jit };
}

function makeMark(canvas, name, tint, index, animateIn) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 92;
  const h = canvas.clientHeight || 92;

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);

  const seed = hash32(name);
  const n = 300;
  const cloud = buildCloud(seed, n);

  return {
    canvas,
    ctx: canvas.getContext('2d'),
    dpr, w: canvas.width, h: canvas.height,
    n,
    pos: cloud.pos, scat: cloud.scat, jit: cloud.jit,
    rgb: hexToRgb(tint),
    lut: [],
    alpha: 1,
    rotY: (seed % 628) / 100,            // 每个标记起始角度不同
    rotX: -0.32,
    tiltTarget: -0.32,
    spin: 0.34,
    spinScale: 1,
    hover: false,
    assemble: animateIn ? 0 : 1,
    delay: index * 60,                   // 逐行错开的入场
    visible: false,
    drawn: false
  };
}

function drawMark(m) {
  const { ctx, w, h, n, pos, scat, jit, rgb } = m;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.4;

  // 入场进度（缓出）
  const t = m.assemble;
  const e = t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
  const scatter = 1 - e;

  const g = m.hover ? 1.25 : 1;
  const cosY = Math.cos(m.rotY), sinY = Math.sin(m.rotY);
  const cosX = Math.cos(m.rotX), sinX = Math.sin(m.rotX);

  // 按远近分 12 档预先算好颜色，避免每个点都拼字符串。
  // 远端的亮度/透明度下限要给足，否则整团点云会散成几颗孤立的亮点。
  const L = 12;
  for (let k = 0; k < L; k++) {
    const d = k / (L - 1);                       // 0 远 → 1 近
    const mul = 0.55 + 0.45 * d;
    const a = (0.34 + 0.66 * d) * e * g;
    m.lut[k] = `rgba(${(rgb[0] * mul) | 0},${(rgb[1] * mul) | 0},${(rgb[2] * mul) | 0},${a.toFixed(3)})`;
  }

  const base = m.dpr;

  for (let i = 0, k = 0; i < n; i++, k += 3) {
    let x = pos[k], y = pos[k + 1], z = pos[k + 2];

    if (scatter > 0.001) {
      const s = 1 + scatter * 1.9;
      x = x * s + scat[k] * scatter;
      y = y * s + scat[k + 1] * scatter;
      z = z * s + scat[k + 2] * scatter;
    }

    const X = x * cosY + z * sinY;
    const Z = -x * sinY + z * cosY;
    const Y = y * cosX - Z * sinX;
    const Z2 = y * sinX + Z * cosX;

    const persp = 2.9 / (2.9 + Z2);
    const px = cx + X * persp * R;
    const py = cy - Y * persp * R;

    let d = (Z2 + 1.15) / 2.3;
    d = d < 0 ? 0 : d > 1 ? 1 : d;

    ctx.fillStyle = m.lut[(d * (L - 1)) | 0];
    const sz = (0.7 + 1.3 * d) * jit[i] * base;
    ctx.fillRect(px, py, sz, sz);
  }
}

const ASSEMBLE_MS = 900;

function tick() {
  mark.raf = requestAnimationFrame(tick);

  // 全程只用 performance.now() 一个时钟源。
  // rAF 回调传入的时间戳在虚拟时钟环境下可能不推进，拿它和别的时钟相减
  // 会得到恒为 0 的 dt，点云就永远停在散开状态、看起来一团糊。
  const now = performance.now();

  const elapsed = now - mark.last;
  if (elapsed < mark.frame) return;
  mark.last = now;

  if (mark.epoch === null) mark.epoch = now;

  // 旋转按真实秒数推进，不按帧数 —— 否则帧率一变转速就跟着变
  const dtSec = Math.min(elapsed / 1000, 0.1);
  const ease = Math.min(dtSec * 4, 1);

  for (const m of mark.instances) {
    if (!m.visible) continue;

    if (m.assemble < 1) {
      const dt = now - (mark.epoch + m.delay);
      m.assemble = dt <= 0 ? 0 : dt >= ASSEMBLE_MS ? 1 : dt / ASSEMBLE_MS;
    }

    const target = (m.hover ? 1.75 : 0.34) * m.spinScale;
    m.spin += (target - m.spin) * ease;
    m.rotY += m.spin * dtSec;
    m.rotX += (m.tiltTarget - m.rotX) * ease;

    drawMark(m);
    m.drawn = true;
  }
}

const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      for (const en of entries) {
        const m = mark.instances.find((x) => x.canvas === en.target);
        if (!m) continue;
        m.visible = en.isIntersecting;
        if (m.visible && !m.drawn) drawMark(m);
      }
    }, { rootMargin: '120px' })
  : null;

function mountMarks(animateIn) {
  mark.instances = [];
  if (animateIn) mark.epoch = null;      // 重新计时，让入场动画从头开始

  if (!mark.reduced && mark.raf === null) {
    mark.last = 0;
    mark.raf = requestAnimationFrame(tick);
  }

  const canvases = el.list.querySelectorAll('canvas[data-cloud]');
  canvases.forEach((canvas, i) => {
    const tint = canvas.dataset.tint || PALETTE[i % PALETTE.length];
    const m = makeMark(canvas, canvas.dataset.cloud, tint, i, animateIn && !mark.reduced);
    mark.instances.push(m);

    if (io) {
      io.observe(canvas);
    } else {
      m.visible = true;
    }

    if (mark.reduced) {
      m.assemble = 1;
      drawMark(m);
    }
  });
}

/* ==========================================================================
   数据
   ========================================================================== */

/**
 * 读取仓库里的静态快照（repos.json）。
 * 用于浏览器直连 GitHub API 被拦截时兜底 —— 典型场景是访客装了
 * GitHub 加速器（Steam++ / Watt Toolkit 等），它们会把 api.github.com
 * 通过 hosts 指到 127.0.0.1，而 Chromium 禁止公网页面请求回环地址。
 * 快照由 .github/workflows/refresh-repos.yml 每天自动刷新。
 */
async function fetchSnapshot() {
  const res = await fetch('repos.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('no-snapshot');
  const data = await res.json();
  const at = data.generated_at ? new Date(data.generated_at).getTime() : null;
  return { repos: data.repos || [], at };
}

/** 取仓库列表：实时 API → 本地缓存 → 静态快照 */
async function fetchRepos(opts) {
  const key = 'ft-portal-cache-v1';
  const ttl = opts.cacheMinutes * 60 * 1000;
  let cached = null;

  try {
    const raw = localStorage.getItem(key);
    if (raw) cached = JSON.parse(raw);
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }

  if (cached && Date.now() - cached.at < ttl) {
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
    if (cached) return { repos: cached.repos, source: 'stale', at: cached.at };

    try {
      const snap = await fetchSnapshot();
      if (snap.repos.length) return { repos: snap.repos, source: 'snapshot', at: snap.at };
    } catch { /* 快照也读不到，继续往下抛 */ }

    throw err;
  }
}

function buildProjects(repos, cfg) {
  const opts = cfg.options;
  const hidden = new Set((cfg.hidden || []).map((s) => s.toLowerCase()));
  const exclude = new Set((opts.exclude || []).map((s) => s.toLowerCase()));
  const selfName = `${opts.username}.github.io`.toLowerCase();

  const list = repos
    .filter((r) => {
      const n = r.name.toLowerCase();
      if (n === selfName) return false;
      if (hidden.has(n) || exclude.has(n)) return false;
      if (r.archived || r.disabled) return false;
      if (opts.hideForks && r.fork) return false;
      if (opts.requirePages && !r.has_pages) return false;
      return true;
    })
    .map((r) => {
      const custom = cfg.projects?.[r.name] || {};
      const pushed = r.pushed_at || r.updated_at;
      const tags = custom.tags || (r.language ? [r.language] : []);
      return {
        name: r.name,
        title: custom.title || humanize(r.name),
        desc: custom.description || r.description || '',
        tags,
        tint: custom.tint || PALETTE[hash32(r.name) % PALETTE.length],
        url: demoUrl(r, opts),
        pushed,
        ago: timeAgo(pushed),
        isNew: isFresh(pushed, opts.newDays)
      };
    });

  // order 里写了的按写的顺序排前面，其余的一律按更新时间倒序
  const rank = new Map((cfg.order || []).map((n, i) => [n.toLowerCase(), i]));
  list.sort((a, b) => {
    const ra = rank.has(a.name.toLowerCase()) ? rank.get(a.name.toLowerCase()) : Infinity;
    const rb = rank.has(b.name.toLowerCase()) ? rank.get(b.name.toLowerCase()) : Infinity;
    if (ra !== rb) return ra - rb;
    return new Date(b.pushed) - new Date(a.pushed);
  });

  return list;
}

/* ==========================================================================
   渲染
   ========================================================================== */

let ALL = [];
let query = '';
let painted = false;         // 首次渲染才播放聚拢动画

function rowHTML(p, i) {
  const tags = p.tags.slice(0, 3)
    .map((t) => `<span>${esc(t)}</span>`)
    .join('');

  // 注意：.work-date 必须是 .work 的直接子元素，否则 grid-area: date 不生效，
  // 日期会被挤到正文底下单独占一行。
  return `
  <a class="work${p.isNew ? ' is-fresh' : ''}" href="${esc(p.url)}"
     target="_blank" rel="noopener noreferrer" style="--tint:${esc(p.tint)}">
    <span class="work-mark">
      <canvas data-cloud="${esc(p.name)}" data-tint="${esc(p.tint)}"></canvas>
    </span>
    <span class="work-body">
      <span class="work-title">${esc(p.title)}</span>
      ${p.desc ? `<span class="work-desc">${esc(p.desc)}</span>` : ''}
      ${tags ? `<span class="work-meta"><span class="work-tags">${tags}</span></span>` : ''}
    </span>
    <span class="work-date">${esc(p.ago)}</span>
  </a>`;
}

function renderGhost(n = 6) {
  el.list.innerHTML = Array.from({ length: n }, () => `
    <div class="ghost" aria-hidden="true">
      <span class="ghost-mark"></span>
      <span class="ghost-lines"><i></i><i></i></span>
    </div>`).join('');
}

function render() {
  const q = query.trim().toLowerCase();
  const list = q
    ? ALL.filter((p) =>
        (p.title + ' ' + p.name + ' ' + p.desc + ' ' + p.tags.join(' '))
          .toLowerCase().includes(q))
    : ALL;

  if (!list.length) {
    el.list.innerHTML = `
      <div class="note">
        <h2>${q ? '没有匹配的作品' : '还没有已上线的作品'}</h2>
        <p>${q
          ? '换一个词再试试。'
          : '在 GitHub 上建好仓库后，到仓库的 <code>Settings → Pages</code> 把 Pages 打开，'
            + '这里就会自动出现，不需要改这个网站的任何文件。'}</p>
      </div>`;
    return;
  }

  el.list.innerHTML = list.map(rowHTML).join('');
  mountMarks(!painted);
  painted = true;
  bindRows();
}

function bindRows() {
  mark.instances.forEach((m) => {
    const row = m.canvas.closest('.work');
    if (!row) return;

    row.addEventListener('pointerenter', () => { m.hover = true; });

    row.addEventListener('pointermove', (e) => {
      const r = row.getBoundingClientRect();
      const ny = (e.clientY - r.top) / r.height * 2 - 1;
      const nx = (e.clientX - r.left) / r.width * 2 - 1;
      m.tiltTarget = -0.32 + ny * 0.30;
      m.spinScale = 1 + nx * 0.5;
    }, { passive: true });

    row.addEventListener('pointerleave', () => {
      m.hover = false;
      m.tiltTarget = -0.32;
      m.spinScale = 1;
    });
  });
}

function renderError(err) {
  const rate = err && err.message === 'rate-limit';
  el.list.innerHTML = `
    <div class="note">
      <h2>${rate ? 'GitHub 接口请求太频繁了' : '没能读到作品列表'}</h2>
      <p>${rate
        ? '未登录访问 GitHub 接口每小时限 60 次，等几分钟再刷新就好。'
        : '浏览器没能连上 GitHub 接口。如果你开着 GitHub 加速器'
          + '（Steam++、Watt Toolkit 等），它会把 <code>api.github.com</code> 指向本机，'
          + '浏览器会拦截这类请求 —— 关掉加速器再刷新即可。'}</p>
      <button type="button" id="retry">重新加载</button>
    </div>`;
  const btn = $('#retry');
  if (btn) btn.addEventListener('click', () => boot());
}

function setSync(source, at) {
  if (!el.sync) return;
  const label = {
    network: '实时同步自 GitHub',
    cache: '已同步',
    snapshot: '离线快照',
    stale: '离线显示上次结果'
  }[source] || '已同步';

  const date = at
    ? new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
    : '';
  el.sync.textContent = date ? `${label}，${date}` : label;

  if (el.syncDot) {
    el.syncDot.classList.toggle('is-offline', source === 'stale' || source === 'snapshot');
  }
}

function setCount(n) {
  if (el.count) el.count.textContent = n;
  if (el.footCount) el.footCount.textContent = n;
}

/* ==========================================================================
   启动
   ========================================================================== */

async function loadConfig() {
  try {
    const res = await fetch('links.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('no config');
    const user = await res.json();
    return {
      options:  { ...DEFAULTS.options, ...(user.options || {}) },
      order:    user.order || DEFAULTS.order,
      hidden:   user.hidden || DEFAULTS.hidden,
      projects: user.projects || DEFAULTS.projects,
      site:     user.site || {}
    };
  } catch {
    return { ...DEFAULTS, site: {} };
  }
}

function applySite(site) {
  if (!site) return;
  if (site.name) {
    const n = $('#site-name');
    const b = $('#site-brand');
    if (n) n.textContent = site.name;
    if (b) b.textContent = site.name;
    document.title = `${site.name} · 作品`;
  }
  const intro = $('#site-intro');
  if (intro && (site.intro || site.bio)) intro.textContent = site.intro || site.bio;
  const gh = $('#site-github');
  if (gh && site.github) gh.href = site.github;
}

async function boot() {
  renderGhost();
  const cfg = await loadConfig();
  applySite(cfg.site);

  try {
    const { repos, source, at } = await fetchRepos(cfg.options);
    ALL = buildProjects(repos, cfg);
    setCount(ALL.length);
    setSync(source, at);

    if (el.searchBox) el.searchBox.hidden = ALL.length < cfg.options.minProjectsForSearch;

    painted = false;
    render();
  } catch (err) {
    console.warn('[名录] 读取仓库失败：', err);
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

  document.addEventListener('visibilitychange', () => {
    if (mark.reduced) return;
    if (document.hidden && mark.raf !== null) {
      cancelAnimationFrame(mark.raf);
      mark.raf = null;
    } else if (!document.hidden && mark.raf === null) {
      mark.last = 0;
      mark.raf = requestAnimationFrame(tick);
    }
  });

  boot();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
