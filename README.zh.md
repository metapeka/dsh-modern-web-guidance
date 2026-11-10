<p align="center">
  <img src="icon.png" width="96" height="96" alt="dsh-modern-web-guidance">
</p>

<h1 align="center">dsh-modern-web-guidance</h1>

<p align="center">
  Google Chrome 的 <a href="https://github.com/GoogleChrome/modern-web-guidance">Modern Web Guidance</a>，离线运行，<br>
  作为 <a href="https://github.com/deepseek-ai">DeepSeek Harness</a> 插件分发。
</p>

<p align="center">
  208 篇带 Baseline 降级方案的指南 · 4 个工具 · 2 个技能 · 零依赖 · 仅本地统计
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ru.md">Русский</a> ·
  <b>中文</b>
</p>

<p align="center">
  <a href="LICENSE"><img alt="许可证" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <a href="package.json"><img alt="依赖" src="https://img.shields.io/badge/dependencies-0-brightgreen"></a>
  <a href="#security-and-limits"><img alt="遥测" src="https://img.shields.io/badge/telemetry-local--only-brightgreen"></a>
  <a href="https://github.com/metapeka/dsh-modern-web-guidance/actions/workflows/test.yml"><img alt="测试" src="https://github.com/metapeka/dsh-modern-web-guidance/actions/workflows/test.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/dsh-modern-web-guidance"><img alt="npm" src="https://img.shields.io/npm/v/dsh-modern-web-guidance"></a>
  <img alt="指南" src="https://img.shields.io/badge/guides-208-2563eb">
  <img alt="DSH 插件" src="https://img.shields.io/badge/DSH-plugin-0d9488">
  <a href="https://www.npmjs.com/package/dsh-modern-web-guidance"><img alt="npm 下载量" src="https://img.shields.io/npm/dm/dsh-modern-web-guidance"></a>
  <a href="https://github.com/metapeka/dsh-modern-web-guidance/releases"><img alt="版本" src="https://img.shields.io/github/v/release/metapeka/dsh-modern-web-guidance?label=release"></a>
</p>

<details>
<summary>📑 目录</summary>

**开始使用** · [你得到什么](#what-you-get) · [安装](#install) · [如何使用](#how-to-use) · [何时用哪个工具](#which-tool-when)

**理解原理** · [与 Google 官方包的区别](#vs-google) · [检索如何工作](#how-search-works) · [目录地图](#catalog-map) · [实验性指南](#experimental-guides)

**日常操作** · [安全与边界](#security-and-limits) · [使用统计](#usage-stats) · [侧边栏面板](#sidebar-panel) · [配置](#configuration) · [更新语料](#updating-the-guide-corpus)

**其他** · [常见问题](#faq) · [路线图](#roadmap) · [文档地图](#docs-map) · [开发](#development) · [发布](#publishing) · [许可](#attribution-and-license)

</details>

---

编程模型默认会写出过时的 Web 代码，因为它们的训练数据里就是这些内容。这个插件把 208 篇经过筛选、节省 token 的
指南放到智能体面前，并提供离线检索，让它优先使用当前平台 API（原生 `<dialog>`/popover、锚点定位、容器查询、视图
过渡、滚动驱动效果、`:has()`、passkey、`fetchpriority` 等），而不是自己写 JavaScript 变通方案或引入库。

一切都本地运行：指南随包分发，检索在进程内计算，没有网络请求。自 0.2.0 起就有使用统计，但它不离开这台机器 ——
见[使用统计](#usage-stats)。

<a id="what-you-get"></a>

## 🧰 你得到什么

| 类型 | 名称 | 说明 |
|---|---|---|
| 工具 | `web_guidance_search` | 用 2–5 个词描述能力，返回排好序的指南 id，可按分类过滤 |
| 工具 | `web_guidance_retrieve` | 返回一篇或多篇指南的完整 markdown（每次调用最多 10 篇 / 120k 字符） |
| 工具 | `web_guidance_list` | 目录总览：各分类数量，或某个分类下的 id 与标题 |
| 工具 | `web_guidance_legacy_scan` | 对显式给出的路径做过时模式（legacy）的正则标记扫描；只报告，不改动任何东西 |
| 技能 | `modern-web-guidance` | 工作流：检索 → 取回 → 实现 → 校验 → 说明降级方案 |
| 技能 | `chrome-extensions` | Manifest V3 开发与 Chrome Web Store 上架要求 |

扫描器只读不写，而且只读代码。`web_guidance_legacy_scan` 接受 `paths`（1–16 个文件或目录，没有默认目标）、可选的
`rules`（最多 33 个规则 id）和 `format: 'summary' | 'json'`；每次调用最多读 200 个文件、单文件 512 kB、合计 8 MB，
最多返回 200 条发现。允许的扩展名是 18 个代码扩展名 —— `.js`、`.jsx`、`.ts`、`.css`、`.html`、`.vue`、`.svelte`、
`.astro`、`.json` 等等 —— markdown 不在其中：`.md` 或 `.mdx` 文件记为跳过而不是读取，因为引用反模式的文档是文档，
不是过时代码。表里一共 33 条规则，覆盖上游 35 条中的 30 条；剩下没覆盖的规则、以及唯一真正的一笔技术债，都记在[对照说明](docs/notes/legacy-scan-parity.md)里。

同一套扫描也给人留了一条命令：`/guidance-scan <paths> [--rules ls-01,ls-13] [--format summary|json]`。它走同一个
扫描器、同一套拒绝规则和上限，而且不给至少一个显式路径就不跑。面板上的扫描按钮就是这条操作，只是把 `.` 替你填好：
它会扫过会话工作区里所有代码文件，并跳过散文。

目录覆盖 `css`、`ui-atoms`、`ui-components`、`ui-behaviors`、`forms`、`html`、`js`、`accessibility`、
`visual-design`、`security`、`performance`、`built-in-ai`、`pwa`、`wasm`、`webmcp`、`privacy` 和
`user-experience`。

<a id="install"></a>

## 🚀 安装

从已发布的包安装：

```shell
dsh plugin --profile desktop add dsh-modern-web-guidance
```

从 GitHub 安装：

```shell
dsh plugin --profile desktop add github:metapeka/dsh-modern-web-guidance
```

从本地副本安装（不需要 registry）：

```shell
dsh plugin --profile desktop add file:E:/path/to/dsh-modern-web-guidance
```

在智能体会话里，`plugin_manager` 的 `action: "install_bundle"` 加上包的绝对路径作为 `target`，效果相同。这个
bundle 只插入一行（`modern-web-guidance`），不需要构建步骤、依赖或原生模块。

<a id="how-to-use"></a>

## 🧭 如何使用

不需要任何配置：插件会自行注册，`modern-web-guidance` 技能会告诉智能体什么时候该用它。有三种使用方式。

<a id="which-tool-when"></a>

### 何时用哪个工具

| 你想要 | 调用 | 返回 |
| --- | --- | --- |
| “现在该怎么做？” | `web_guidance_search` | 用 2–5 个词描述能力，返回排好序的指南 id，可按分类过滤 |
| “把指南给我看” | `web_guidance_retrieve` | 完整 markdown，每次最多 10 篇或 120 000 字符 |
| “这里到底有什么？” | `web_guidance_list` | 各分类数量，或某个分类下的 id 与标题 |
| “目录真的有人在用吗？” | `/guidance-stats` | 文本形式的本地报告；`--json` 是面板读取的格式 |
| “我正要写或要审的代码会不会用上过时写法？” | `web_guidance_legacy_scan` | 对显式列出的路径给出发现，每次最多 200 条 |
| “想自己在终端里跑一遍” | `/guidance-scan src/` | 同样的发现，文本形式；`--format json` 给出机器可读的原始值，`--rules ls-01,ls-13` 收窄规则表 |

### 1. 直接提出 Web 开发需求（默认方式）

技能的路由描述就是“在写 HTML、CSS 或客户端 JavaScript 之前先检索 208 篇用例指南”，所以一句平常的请求就够了 ——
智能体会先检索、取回所需内容，然后按当前平台 API 写代码，而不是写变通方案：

```text
你：加一个点击遮罩就关闭的设置弹窗。

智能体：web_guidance_search({"query": "light dismiss dialog"})
        → light-dismiss-a-dialog, platform-controls-dismiss-dialog, dialog, …
        web_guidance_retrieve({"ids": "light-dismiss-a-dialog,dialog"})
        → 含 closedby/commandfor 示例和 Baseline 降级方案的完整指南
```

### 2. 明确要求它去查

需要确定性时用这种方式，或者当任务明显该查而智能体跳过了检索时：

- “按 modern web guidance 查一下今天应该怎么做”
- “写这段 CSS 之前先查指南”
- “确认一下这是不是 Baseline，把降级方案给我看”
- “找到讲 light-dismiss 对话框的指南并按它实现”

### 3. 自己浏览目录

`web_guidance_list` 回答“到底有什么”，不必花一次取回去看全文：

```text
web_guidance_list({})                             → 17 个分类共 208 篇指南
web_guidance_list({"category": "css"})            → 18 篇 CSS 指南的 id 与标题
web_guidance_search({"query": "view transition"}) → 取回之前的排序候选列表
```

分类过滤很宽容（`" CSS "` 和 `"Css"` 都等同于 `css`），写错分类时返回的是真实分类列表，而不是空结果。

### 典型任务

| 你想要 | 可让智能体使用的查询 | 会落到哪篇指南 |
|---|---|---|
| 点遮罩就关闭的弹窗 | `light dismiss dialog` | `light-dismiss-a-dialog` |
| 弹窗打开时页面不滚动 | `prevent page scroll under modal` | `prevent-page-scroll-under-modal-dialog` |
| 手机上能用的表格 | `responsive data table` | `responsive-table` |
| 深浅色主题切换 | `dark mode toggle` | `dark-mode-toggle` |
| 不用 JavaScript 的滑动标签指示条 | `anchor positioning` | `anchor-positioning-tab-underline` |
| 输入过程中不打扰人的行内校验 | `form validation after interaction` | `validate-input-after-interaction` |
| 免密码登录 | `passkey registration` | `passkey-registration` |
| 更快的 LCP | `prioritize hero image` | `fetchpriority` 相关指南 |
| Manifest V3 扩展 | （技能）`chrome-extensions` | 扩展技能的参考文件 |

<a id="vs-google"></a>

## 🆚 与 Google 官方包的区别

本插件**直接内置 Google 的语料** —— 同样的 208 篇指南，逐字节一致 —— 再补上 DeepSeek Harness 需要的那一层：
面向模型的工具、一个侧边栏面板，以及零运行时依赖。它没有重新实现上游的智能体，也刻意去掉了那些撑不过插件
体积与安全预算的引擎。老实说，差别是这样：

| | Google `modern-web-guidance` | 本插件 |
| --- | --- | --- |
| 形态 | npm 包：一个 CLI 加技能，用 `npx -y modern-web-guidance@latest …` 运行 | DSH 插件：4 个工具、2 个技能、2 条给人用的命令、一个侧边栏面板 |
| 受众 | 任何能执行 shell 命令的智能体 | DeepSeek Harness 会话 |
| 指南语料 | 208 篇已索引的指南（209 个 `.md` 文件，其中一个是逐字节副本） | 同样的 208 篇，逐字节一致，快照 `2026_11_09-5bcc021b` |
| 检索方式 | `gen/` 里预计算好的资源 —— 量化词向量（`query-words.i8`，7.47 MB）与分块 embedding，合计 9.16 MB | 在进程内用 `guides.json` 和指南正文构建 BM25：没有资源文件，不下载模型（在 30 条查询的探针上测得 29/30 的 top-1） |
| 运行时依赖 | Node 加上包里附带的 CLI 引擎 | 无 |
| 网络 | `npx` 先取包，之后本地运行 | 从不联网 —— 语料就在包里 |
| legacy-scan 扫描 | 4.99 MB 的 `legacy-scan` 引擎，带扫描 → 校验 → 报告 → 现代化四步工作流 | 0.5.0 起内置：零依赖的正则扫描器，33 条规则（其中 30 条对应上游规则），只接受显式路径，只输出报告；0.7.0 起还多了一条给人用的命令 `/guidance-scan`，0.7.1 起它只读代码 |
| 实验性指南 | 在 CLI 内部做门控 | `web_guidance_search` 结果里的 `[experimental]` 标记，`web_guidance_retrieve` 开头的警告横幅 |
| 使用情况洞察 | 无 | 本地计数、`/guidance-stats` 报告、`/guidance-scan` 命令，以及把两者都画出来的侧边栏面板 |
| 语言 | 英文指南 | 同样的指南；文档 EN/RU/ZH，面板 EN/RU/ZH |
| 体积 | — | 256 个文件，打包 895 kB，解包 2.6 MB |

实际意味着：如果你在 DeepSeek Harness 之外工作，就用他们的包 —— 它是参考实现，语料也归它所有。在 Harness
里面，你要的是工具出现在模型的工具列表里、安装不需要构建步骤也不联网，以及一个能看出指南到底有没有人在用的
面板；那就是本插件。

<a id="how-search-works"></a>

## 🧠 检索如何工作

`lib/guidance.js` 在首次使用时为内置语料建立 BM25 索引（约 1.9 MB markdown，几百毫秒建好并缓存）：标题、id、
描述、`featuresUsed`、各级标题与正文，配合停用词过滤、小型英文词干器、前缀扩展，以及精确 id/标题命中的加权。
没有 embedding、没有内置模型、没有 TensorFlow.js —— 包保持小巧，每个结果都能解释。

与上游的语义检索相比，短语式查询（`"light dismiss dialog"`、`"anchor positioning"`）会把对应的具体指南排在第一
位；宽泛的主题查询排序可能不同。如果检索没命中，`web_guidance_list` 会告诉你目录里有什么。

<a id="catalog-map"></a>

## 🗺 目录地图

一切都本地运行，所以目录好不好用，全看智能体能不能找到对的那篇指南。`web_guidance_list` 在运行时打印这些
数量；下面是快照 `2026_11_09-5bcc021b` 的样子。

<details>
<summary>各分类数量（208 篇指南，17 个分类）</summary>

| 分类 | 指南数 | 分类 | 指南数 |
| --- | --- | --- | --- |
| `ui-behaviors` | 40 | `html` | 8 |
| `performance` | 26 | `js` | 5 |
| `ui-components` | 22 | `accessibility` | 4 |
| `visual-design` | 22 | `built-in-ai` | 4 |
| `forms` | 19 | `user-experience` | 3 |
| `css` | 18 | `webmcp` | 3 |
| `security` | 17 | `pwa` | 2 |
| `ui-atoms` | 13 | `privacy` · `wasm` | 1 · 1 |
| | | **合计** | **208** |

</details>

<a id="experimental-guides"></a>

## 🧪 实验性指南

208 篇指南里有 18 篇讲的是不能默认可用的平台特性：其中 8 篇对应的功能在 Chrome 里还挂在 Origin Trial 后面，
另外 10 篇只在单一引擎里实现、仍不稳定。上游在自己的索引里给它们打了标记；本插件把这个标记放到智能体真正
看得到的地方：

- `web_guidance_search` 在命中的结果后面追加 `[experimental]`；
- `web_guidance_retrieve` 在指南开头放一段 `> [!WARNING]` 横幅，写明原因；
- 指南正文本身没有改动 —— 与上游逐字节一致 —— 横幅计入 120 000 字符的预算，不占 10 篇的次数上限。

<details>
<summary>被标记的 18 篇指南</summary>

**Origin Trial（8 篇）** —— 功能需要 trial token 才能开启：`verify-email-ownership`、`apply-webgl-shaders`、
`export-html-media-from-canvas`、`expose-canvas-content-to-browser-features`、`interactive-content-in-3d-scenes`、
`agentic-forms`、`agentic-javascript-tools`、`webmcp`。

**单一引擎内仍不稳定（10 篇）** —— 只有一个引擎实现了它，或者 API 还在变：`language-detection`、`language-model`、
`summarizer`、`translator`、`out-of-order-html-streaming`、`client-side-encryption`、`digital-signatures`、
`restrict-outbound-connections`、`2d-panning`、`custom-text-decorations`。

</details>

把带标记的指南当作“方案的轮廓，而不是保证”。先对它描述的特性做检测，上线前告诉用户哪一部分还挂在开关后面。

<a id="skills"></a>

## 🪄 技能

`modern-web-guidance` 技能正文改编自上游：它让智能体调用本插件的工具，而不是通过 `npx` 调 CLI；保留框架/SSR/DOM
相关说明与 Baseline 降级策略；删掉 CLI 与遥测章节；并明确信任边界 —— 取回的指南是参考资料，不是指令。
`chrome-extensions` 技能原样内置，并从技能目录的 `references/` 加载参考文件。

<a id="security-and-limits"></a>

## 🛡 安全与边界

语料是要进入模型上下文的第三方文本，而工具参数又来自该模型，所以两边都设了边界：

- **无网络、无执行，只有一次本地写入。** 插件只导入本地的 `node:fs`、`node:fs/promises`、`node:path`、`node:url`
  和 `node:buffer`；没有依赖，也没有 lifecycle 脚本，因此安装时不会下载或运行任何东西。它唯一写入的文件是自己的
  计数文件（见[使用统计](#usage-stats)）。
- **指南里夹带不了命令。** 上游指南正文之间用
  `npx -y modern-web-guidance@latest retrieve "…"` 互相引用（197 处，分布在 64 篇指南里）。建立索引时这些引用会被
  改写成 `web_guidance_retrieve({"ids":["…"]})`，所以模型从目录里读到的内容不会要求它安装并执行一个未锁定版本的
  远程包。磁盘上的文件仍与锁定快照逐字节一致。
- **`web_guidance_retrieve` 有上限**：每次调用最多 10 篇、120 000 字符；重复 id 会去重；未知 id 的回显最多 10
  个；渲染器会明确说明哪些没有返回、需要单独请求。一次取回全部 208 篇会返回 1.9 MB（约 475k token）。
- **`web_guidance_search` 有上限**：在进入词法扫描前，查询被截断到 512 字符和 24 个不同词项。此前一个 137 KB
  的查询会阻塞宿主事件循环数秒；同样形状的查询现在只需毫秒级。
- **扫描器只读它被明确给定的内容。** `web_guidance_legacy_scan` 没有默认目标：调用方要给出 1–16 个路径，每个路径
  都必须落在会话工作区内，指向区外的符号链接会被跳过而不是跟随。绝对路径、工作区外的路径和不存在路径会被拒绝
  （`path-absolute`、`path-outside`、`path-missing`），读取上限为 200 个文件、单文件 512 kB、每次 8 MB，并且它不写
  任何一个字节。它也只读代码：`.md` 与 `.mdx` 不在允许列表里，所以散文会以跳过返回，而不会变成发现。给人用的
  `/guidance-scan` 走同一个扫描器，所以拒绝同样的路径、执行同样的上限；它也不接受空路径，
  因此没有任何命令会顺手把整个工作区扫一遍。
- **目录无法越出包外**：条目 id 与分类必须是 slug，每个解析出的路径都会校验是否位于数据目录内。被篡改的
  `guides.json` 此前可以读取磁盘上任意 `*.md`。
- **失败会重试，且不泄露信息**：一次临时的读取错误不再让工具在本次会话中永久失效，错误信息也不再暴露安装的
  绝对路径。

这些性质由 `test/hardening.test.mjs` 覆盖（该文件在加固前的代码上会失败），扫描器的隔离与上限则由
`test/scan-core.test.mjs` 覆盖。完整审计 —— 三份报告与可运行的复现
脚本 —— 位于 [`audit/`](audit/)；只要缺陷仍然存在，`audit/repro/` 下的脚本就会以非零码退出。

<a id="usage-stats"></a>

## 📊 使用统计

自 0.2.0 起，插件记录四个工具到底被问了什么。计数只在本地：没有上报端点、没有分析服务、没有第三方 SDK，任何东西都不离开这台
机器。

查看用的是给人用的斜杠命令，不是智能体能调用的工具：

```text
/guidance-stats                 最近 7 天按工具的汇总
/guidance-stats --days 30       更大的时间窗口
/guidance-stats --json          同样的报告，JSON 格式
/guidance-stats --reset --yes   全部清除
```

`--days N` 默认为 7。统计内容：各工具调用次数、结果分布（hit、miss、unknown id、list、error）、按天计数、各分类
命中次数、各指南被取回次数，以及最近 1000 次调用携带的查询文本和返回的 id。未命中的查询才是重点 —— 无法复现的
未命中就无法修复。

0.5.0 在同一份报告里加了第四行（`legacy-scan`）和一个发现总数。0.7.0 把扫描的细节也留在报告里：命中过哪些规则和
指南，以及最近一次完成的扫描（时间、读了几个文件、多少条发现）—— 报告里就是 `Most matched rules: …` 与
`Last scan: …` 两行。只有 id 和数字，没有路径，也没有代码片段。

存放位置：profile 的持久存储，也就是本来就存会话日志的那层信任边界。默认保留 90 天，`--reset --yes` 会立即清空。

关闭方式：在插件配置里设 `enabled: false` —— 此时不注册监听，也不写文件。

<a id="sidebar-panel"></a>

## 🖥 侧边栏面板

插件增加了客户端部分：左侧栏的图标会在中央区域打开 **Guidance Insights** 面板。它把 `/guidance-stats` 打印的计数
画成一张地图，按顺序回答四个问题：

- **用了多少、准不准** —— 总调用次数，以及按“本来可能命中”的调用算出的命中率（检索命中、检索未命中、未知 id）；
  报告里那个“按全部调用算”的比例放在图块的提示里。`7 天` / `30 天` 开关重新读取时间窗口
- **什么时候用的** —— 每日调用，一天一根柱子
- **用什么、结果如何** —— 按工具和按结果的两列并列
- **扫描器发现了什么** —— 最近一次完成的扫描、命中最多（最多 10 条）的规则，以及这些发现指向的指南；下面的按钮
  会扫过当前会话工作区里所有代码文件（markdown 记为跳过并显示出来），并把这一次的结果就地显示

再往下是报告里的清单：热门查询及其各自的命中与未命中、对 208 篇指南的分类覆盖、没有结果的查询，以及从未被
检索过的指南 —— 按 id 列出，最多 20 条。

刷新会重新读取计数，`7 天` / `30 天` 开关则把 `/guidance-stats --json --days N` 发给宿主。对话里，扫描结果渲染成
表格 —— 规则、位置、置信度、指南 —— 最多 16 行，多出来的显示“另有 N 条”，不管调用要的是哪种格式。

面板除了扫描按钮之外只读：它不改计数、不离开这台机器，也不新增网络请求和工具 —— 四个工具仍然是四个。由它发起的
扫描和别的扫描一样计数。面板里刻意不显示路径和代码片段：面板给的是计数，不是证据；文件和行号在对话的那条工具
调用里。`/guidance-stats` 仍然是给终端和智能体用的文本版本（含 `--json`），而 `/guidance-scan` 是按钮的文本版本。

<a id="configuration"></a>

## ⚙️ 配置

插件不需要配置就能工作。它把工具与技能注册到宿主上下文；如果 profile 没有 `tools` 或 `skills` 服务，它就保持
静默。唯一的设置是插件配置里的 `enabled`：设为 `false` 就关闭本地统计，`/guidance-stats` 也随之消失；`/guidance-scan`
照常可用，因为扫描不是计数（见[使用统计](#usage-stats)）。

<a id="updating-the-guide-corpus"></a>

## 🔄 更新指南语料

语料是上游 `modern-web-guidance@1.0.0` 的锁定快照（技能版本 `2026_11_09-5bcc021b`）。更新步骤：

1. 下载上游 npm tarball。索引位于 `gen/` 而不是包根目录：把
   `package/skills/modern-web-guidance/gen/guides.json` 复制为 `data/guides.json`，把
   `package/skills/modern-web-guidance/guides/` 复制到 `data/guides/`。只放入索引里列出的指南
   （209 个文件中的 208 个：`built-in-ai/prompt-api.md` 是 `language-model.md` 的逐字节副本，索引里没有它）。
   把 `package/skills/chrome-extensions` 复制到 `data/skills/`。
2. 保留 `data/skills/modern-web-guidance/SKILL.md`（本插件的改编版本），不要用面向 CLI 的上游文件覆盖它。
3. 运行 `npm test`，确认语料仍能加载、冒烟查询排序仍然正确。如果有任何被返回的指南让智能体去运行上游 CLI，
   测试同样会失败，所以刷新语料后不需要手工再清理一遍 npx —— 改写发生在加载时（`lib/guidance.js`，
   `CLI_REFERENCE`）。

<a id="faq"></a>

## ❓ 常见问题

**插件装了却什么也看不到。** bundle 只插入一行（`modern-web-guidance`），不需要构建步骤。执行
`dsh plugin --profile desktop add …` 之后重启 DSH；工具会出现在下一次会话的工具列表里，面板则以左侧栏图标
的形式出现。

**检索结果没什么用。** 查询是用 2–5 个词描述一项能力（“light dismiss dialog”、“view transition”、
“container query”），不是整句。如果还是没命中，先调 `web_guidance_list` 看各分类总览，再按 id 取回。

**为什么结果里写着 `[experimental]`？** 指南讲的平台特性挂在 Origin Trial 后面，或者只在单一引擎里实现、仍
不稳定 —— 见[实验性指南](#experimental-guides)。指南本身仍然是正确的方向；上线前先做特性检测。

**legacy 扫描器到底能做什么？** 它是正则标记扫描，不是解析器：33 条规则逐行匹配，覆盖 208 篇指南中的 33 篇
（15.9%），没有 AST、没有数据流分析、也不自动修复 —— 它只报告，然后停下。它读代码而不是散文：18 个代码扩展名，
`.md` 文件即使被显式点名也以 `extension` 为原因跳过，因为引用反模式的 README 属于文档。它不声称与 Chrome 自己的
`legacy-scan` 等价：那边是 4.99 MB、内置 TypeScript 编译器的引擎，这里是零依赖的扫描过程，既可能误报也可能漏报，
所以把发现当成待核实的线索，而不是结论。

**会有东西离开这台机器吗？** 不会。语料就在包里，检索在进程内计算，没有任何网络请求。使用计数是本地文件，
可以用 `enabled: false` 关掉 —— 见[安全与边界](#security-and-limits)和 [ADR 0001](docs/adr/0001-local-telemetry.md)。

**Google 说 203 个用例，这里为什么写 208？** 上游自己数的是 203 篇*用例*指南；索引里有 208 条，多出来的 5 篇
是各领域总览（`accessibility`、`forms`、`html`、`performance`、`security`）。本插件跟着索引走。

**支持哪些 DSH 版本？** `engines.dsh` 是 `>=0.2.0-rc.1 <0.3.0-0`，Node 是 `>=22.19.0`。工具本身可以独立工作；
面板还需要宿主提供 `slots`、`locale` 和 `remote` 服务。

<a id="roadmap"></a>

## 🚦 路线图

| 版本 | 状态 | 内容 |
| --- | --- | --- |
| 0.4.0 | 已发布 | 上游 v1.0.0 语料（208 篇指南）加实验性标记 |
| 0.4.1 | 已发布 | 文档：导航、对比表、目录地图 |
| 0.5.0 | 已发布 | `legacy-scan` 作为第四个工具：30 条正则规则，只接受显式路径，只输出报告 —— `web_guidance_legacy_scan`，面板里多一个计数器和一个发现总数。设计与结论：[docs/notes/legacy-scan-feasibility.md](docs/notes/legacy-scan-feasibility.md) |
| 0.6.0 | 已发布 | 再多三条规则（`:host-context()`、文本平衡、`select:invalid`），规则表增至 33 条，其中 30 条对应上游规则；另加指南哈希校验，语料更新后规则不会悄悄过期 |
| 0.7.0 | 已发布 | 面板从计分板变成地图：时间窗口开关、每日调用、按工具与按结果、按 id 列出的未读指南、诚实的命中率、扫描器发现了什么，外加一个扫描按钮；同时加入 `/guidance-scan` 这条给人用的扫描命令，以及对话里的发现表格 |
| 0.7.1 | 已发布 | 扫描器不再读文档：`.md` 与 `.mdx` 移出允许列表，改为记为跳过，因此只有散文有问题的项目会扫出干净结果 |

刻意**不**做的：内置上游那 9.16 MB 的 embedding 表，或者它那个附带 TypeScript 编译器的 4.99 MB `legacy-scan`
引擎。两者都会破坏“零运行时依赖、不联网、不生成代码”，而换来的收益在词法索引上根本看不出来。

<a id="docs-map"></a>

## 📚 文档地图

| 文档 | 什么时候读 |
| --- | --- |
| [`docs/README.md`](docs/README.md) | 想看这个仓库的完整地图 |
| [`PUBLISHING.md`](PUBLISHING.md) | 你要发版：npm 规则、trusted publishing、发布流程 |
| [`docs/releases/README.md`](docs/releases/README.md) | 你要写发布说明 —— 团队的行文风格就在这里 |
| [`AGENTS.md`](AGENTS.md) | 你是要在这个仓库里干活的智能体：CI、客户端部分、各项约定 |
| [`GLOSSARY.md`](GLOSSARY.md) | 某个术语在这个代码库里说不清楚 |
| [`NOTICE`](NOTICE) | 署名：哪些来自上游、哪些被去掉，以及为什么 |
| [`audit/`](audit) | 想看 0.1.x 的安全、语料与缺陷审计原文 |
| [`docs/adr/`](docs/adr) | 想看决策记录：本地遥测，以及之后的演变 |
| [`docs/notes/`](docs/notes) | 想看某次发布背后的调研（上游 diff、可行性研究、计划） |
| [`docs/notes/legacy-scan-feasibility.md`](docs/notes/legacy-scan-feasibility.md) | 想看 `legacy-scan` 背后的分析：上游引擎做什么、正则扫描能匹配到什么、以及结论 |

<a id="development"></a>

## 🧑‍💻 开发

```shell
npm test
```

`npm test` 会跑 207 个测试，分布在十四个文件里：`guidance.test.mjs` 覆盖索引、排序、取回与词干器；
`plugin.test.mjs` 用模拟的 Cordis 上下文挂载插件；`hardening.test.mjs` 守住安全不变量；`report.test.mjs`、
`stats.test.mjs`、`store.test.mjs` 和 `telemetry.test.mjs` 覆盖计数管线及其 0.7.0 的扫描字段；
`scan-core.test.mjs`、`scan-rules.test.mjs` 和 `scan-tool.test.mjs` 覆盖扫描器的隔离、规则表与工具契约，
`scan.test.mjs` 是端到端扫描，`scan-command.test.mjs` 则要求 `/guidance-scan` 拒绝同样的路径、返回同样的值；
`scan-guides.test.mjs` 校验规则表指向的指南哈希；`client-locales.test.mjs` 保证面板的三份词典保持同步。在禁止
子进程的沙箱里，请直接运行文件（`node test/hardening.test.mjs`）。

<a id="publishing"></a>

## 📦 发布

上架目录与 npm 发布步骤见 [PUBLISHING.md](PUBLISHING.md)；已准备好的 awesome-dsh-plugin 条目位于
[`market/awesome-dsh-plugin.yml`](market/awesome-dsh-plugin.yml)。

<a id="attribution-and-license"></a>

## ⚖️ 署名与许可

Apache-2.0。指南语料、`chrome-extensions` 技能以及改编版 `SKILL.md` 的源文本来自
[GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance)（Copyright Google LLC，
Apache-2.0）。具体复制、改编与删除了哪些内容，见 [NOTICE](NOTICE)。

本插件不是 Google 官方产品。它移除了上游 CLI（`modern-web.mjs`、`search.mjs`、`legacy-scan.mjs`）、`gen/` 下预计算的语义检索表，以及上游 CLI 附带的 Clearcut 遥测看门狗（0.x 版本的包里放的是 TensorFlow.js MiniLM 模型，而不是这些表）。
