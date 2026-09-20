# 白给Turbo · 作品导航页

在线地址：**https://freeturbo.github.io/**

一个自动同步的作品集首页。页面打开时实时调用 GitHub 公开 API 拉取仓库列表，
筛出**已开启 GitHub Pages** 的仓库，自动拼出演示地址并渲染成卡片。

## 它怎么做到「自动更新」的

页面本身没有构建步骤。实时数据靠 API，兜底数据靠一份每天自动刷新的快照。

```
访客打开页面
      ↓
读取 links.json（标题/描述/排序）
      ↓
实时请求 api.github.com/users/FreeTurbo/repos
      ↓
筛选 has_pages = true 的仓库  →  生成卡片
      ↓
成功 → 结果缓存到浏览器本地 5 分钟
失败 → 回落到仓库里的静态快照 repos.json
```

所以你新建仓库之后：

1. 把网页推到新仓库
2. 到新仓库的 **Settings → Pages**，Source 选 `main` 分支、目录选 `/ (root)`，保存
3. 等约 1 分钟部署完成

**然后什么都不用做**——访客刷新导航页，新作品就自动出现在里面了。
不需要改这个仓库的任何文件，也不需要重新部署。

> ⚠️ 唯一的前提是第 2 步：GitHub 不会自动为普通仓库开启 Pages。
> 没开 Pages 的仓库会被导航页自动跳过（因为无页面可跳转）。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面骨架，一般不用动 |
| `assets/style.css` | 样式，改配色改这里（文件顶部的 `:root` 变量） |
| `assets/app.js` | 自动发现逻辑，一般不用动 |
| `links.json` | **你唯一需要经常改的文件**：标题、描述、标签、排序、隐藏 |
| `repos.json` | 自动生成的静态快照，**不要手改** |
| `tools/snapshot.mjs` | 生成上面那份快照的脚本 |
| `.github/workflows/refresh-repos.yml` | 每天自动刷新快照 |
| `.nojekyll` | 告诉 GitHub Pages 不要跑 Jekyll 处理 |

## 怎么改内容

全部改 `links.json` 一个文件就行。

**给新仓库写介绍** —— 在 `projects` 里加一条，键是仓库名（区分大小写）：

```json
"projects": {
  "seven": {
    "title": "显示在卡片上的标题",
    "description": "一句话介绍，30 字左右最好看",
    "tags": ["标签1", "标签2"],
    "tint": "#8b7cff"
  }
}
```

四个字段都是可选的。不写 `title` 就显示仓库名，不写 `tint` 就按仓库主要语言自动配色。

**不想显示某个仓库** —— 把仓库名加进 `hidden` 数组。

**固定排序** —— 在 `order` 数组里按顺序写仓库名，没写进去的自动排在后面（按更新时间倒序）。

**改站点标题/签名** —— 改 `site` 里的 `name` / `tagline` / `bio` / `github`。

## 注意事项

### ⚠️ GitHub 加速器会让实时同步失效（重要）

如果你或访客开着 **Steam++ / Watt Toolkit** 这类 GitHub 加速器，它们会改 hosts：

```
127.0.0.1 api.github.com
127.0.0.1 github.com
...
```

于是浏览器认为 `api.github.com` 是个**本机回环地址**，而 Chromium 内核禁止
公网页面请求回环地址，会直接报错：

```
Access to fetch at 'https://api.github.com/...' from origin 'https://freeturbo.github.io'
has been blocked by CORS policy: Permission was denied for this request
to access the `loopback` address space.
```

**这不是网页的 bug，也不是 CORS 配置问题**，是加速器的 hosts 劫持 + 浏览器安全策略。

应对办法（页面已经内置）：

- 页面会自动回落到 `repos.json` 静态快照，左下角显示「离线快照 · 日期」，
  内容最多滞后一天，不会开天窗。
- 快照由 `refresh-repos.yml` **每天自动刷新**（在 GitHub 的机器上跑，
  没有 hosts 劫持问题，所以拿得到数据）。
- 想在自己机器上看到实时版本，就把 `api.github.com` 从加速器的加速名单里去掉，
  或者用手机流量 / 换个没装加速器的网络打开对比一下。

本地手动跑快照脚本时，如果开着加速器会报证书错误，加个参数即可：

```bash
node --use-system-ca tools/snapshot.mjs
```

### 其他

- 实时模式用的是**未登录**的 GitHub API，每个 IP 每小时 60 次。页面做了 5 分钟本地缓存，
  正常浏览完全够用；超限时页面会提示稍后再试，并优先显示上次缓存的结果。
- 默认**不显示** fork 来的仓库，也会自动排除导航页自己（`FreeTurbo.github.io`）。
- 仓库有 `homepage` 字段时会优先用那个地址，否则拼 `https://freeturbo.github.io/<仓库名>/`。
  所以如果你给某个仓库绑了自定义域名，页面会自动跟着走。
